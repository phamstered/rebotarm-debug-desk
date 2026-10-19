"""Fixed SSH-side adapter for rebotarm_vla; no robot command publishing."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

PREFIX = "ROBOT_CONSOLE_COLLECTION="


def default_cache():
    domain = int(os.environ.get("ROS_DOMAIN_ID", "0"))
    return Path.home() / ".cache/robot-console/data-collection" / f"domain-{domain}"


def recorder_environment(python):
    environment = dict(os.environ)
    prefix = python.parent.parent
    libraries = []
    for package in ("cu12", "cudss"):
        libraries.extend(sorted(prefix.glob(f"lib/python*/site-packages/nvidia/{package}/lib")))
    if libraries:
        environment["LD_LIBRARY_PATH"] = ":".join(str(path) for path in libraries) + (
            ":" + environment["LD_LIBRARY_PATH"] if environment.get("LD_LIBRARY_PATH") else "")
    environment["PATH"] = str(python.parent) + os.pathsep + environment.get("PATH", "")
    environment["PYTHONUNBUFFERED"] = "1"
    if (prefix / "pyvenv.cfg").is_file():
        environment["VIRTUAL_ENV"] = str(prefix)
    return environment


def process_identity(pid):
    try:
        # The comm field can contain spaces; fields after the last ')' start at state.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if fields[0] == "Z" or b"rebotarm_vla.lerobot_recorder" not in cmdline:
            return None
        return fields[19]
    except (OSError, IndexError):
        return None


class RosServices:
    def __init__(self):
        import rclpy
        from std_srvs.srv import Trigger
        self.rclpy = rclpy
        self.trigger = Trigger
        rclpy.init(args=[])
        self.node = rclpy.create_node("robot_console_collection_" + uuid.uuid4().hex[:12])

    def call(self, action, discovery=1.5, timeout=60):
        client = self.node.create_client(self.trigger, "/lerobot_recorder/" + action)
        try:
            if not client.wait_for_service(timeout_sec=discovery):
                return None
            future = client.call_async(self.trigger.Request())
            self.rclpy.spin_until_future_complete(self.node, future, timeout_sec=timeout)
            if not future.done():
                raise RuntimeError(f"{action} 超时；操作可能仍在执行，请刷新状态后确认")
            response = future.result()
            if response is None or not response.success:
                raise RuntimeError(response.message if response else f"{action} 无响应")
            return response.message
        finally:
            self.node.destroy_client(client)

    def close(self):
        self.node.destroy_node()
        self.rclpy.shutdown()


class RecorderControl:
    def __init__(self, services, cache=None):
        self.services = services
        self.cache = Path(cache) if cache else default_cache()
        self.cache.mkdir(parents=True, exist_ok=True)
        self.manifest = self.cache / "lerobot-recorder.json"
        self.log_path = self.cache / "lerobot-recorder.log"

    def metadata(self):
        try:
            value = json.loads(self.manifest.read_text())
            if isinstance(value, dict):
                return value
        except (OSError, ValueError):
            pass
        return {}

    def owned(self, metadata):
        pid = metadata.get("pid", 0)
        identity = metadata.get("identity")
        return bool(isinstance(pid, int) and pid > 1 and identity and process_identity(pid) == identity)

    def log(self):
        try:
            with self.log_path.open("rb") as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - 12000))
                return stream.read().decode("utf-8", errors="replace")
        except OSError:
            return ""

    def status(self):
        metadata = self.metadata()
        owned = self.owned(metadata)
        raw = None if metadata.get("finalizing") and owned else self.services.call("status", timeout=8)
        data = json.loads(raw) if raw is not None else None
        if data is not None and not isinstance(data, dict):
            raise RuntimeError("采集器状态格式无效")
        config = metadata.get("config", {}) if owned or data is None else {}
        summary = metadata.get("lastStatus", {})
        state = "stopped"
        if owned:
            state = "finalizing" if metadata.get("finalizing") else "starting"
        if data is not None:
            state = "recording" if data.get("recording") else "idle"
            if owned:
                metadata["lastStatus"] = data
                self.manifest.write_text(json.dumps(metadata))
        saved = data.get("saved_episodes", 0) if data else summary.get("saved_episodes", 0)
        return {
            "state": state, "managed": owned, "pid": metadata.get("pid", 0) if owned else 0,
            "recording": bool(data and data.get("recording")),
            "pendingFrames": int(data.get("pending_frames", 0)) if data else 0,
            "savedEpisodes": int(saved),
            "fps": int(data.get("fps", 0)) if data else config.get("fps", 0),
            "task": str(data.get("task", "")) if data else config.get("task", ""),
            "repoId": config.get("repoId", ""), "root": config.get("root", ""),
            "message": "", "log": self.log() if owned or data is None else "外部采集器的日志请在原启动终端查看",
        }

    @staticmethod
    def remote_path(value):
        path = Path(value)
        return path if path.is_absolute() else Path.home() / path

    def launch(self, config):
        before = self.status()
        if before["state"] != "stopped":
            raise RuntimeError("已有采集器运行，请先使用或结束现有采集器")
        root = self.remote_path(config["root"])
        python = self.remote_path(config["pythonPath"])
        if not python.is_file():
            raise RuntimeError(f"找不到 LeRobot Python：{python}")
        if config["resume"]:
            if not (root / "meta/info.json").is_file():
                raise RuntimeError("续录目录缺少 meta/info.json")
            info = json.loads((root / "meta/info.json").read_text())
            features = info.get("features", {})
            expected = {"observation.state", "action", "observation.images.wrist"}
            if config["baseImageTopic"]:
                expected.add("observation.images.base")
            actual = {key for key in features if key.startswith("observation.") or key == "action"}
            if info.get("fps") != config["fps"] or actual != expected or any(
                features.get(key, {}).get("shape") != [7] for key in ("observation.state", "action")
            ):
                raise RuntimeError("续录配置与数据集的 FPS、相机集合或七维状态/动作布局不一致")
        elif root.exists():
            raise RuntimeError("保存目录已存在；请更换目录，或选择续录现有数据集")
        environment = recorder_environment(python)
        check = subprocess.run([str(python), "-c", "import rclpy; from lerobot.datasets.lerobot_dataset import LeRobotDataset; import rebotarm_vla.lerobot_recorder"],
                               capture_output=True, text=True, timeout=45, env=environment)
        if check.returncode:
            raise RuntimeError("采集依赖检查失败：" + check.stderr[-8000:])
        arguments = [str(python), "-m", "rebotarm_vla.lerobot_recorder", "--no-keyboard"]
        for key, flag in [("repoId", "--repo-id"), ("task", "--task"), ("fps", "--fps"),
                          ("wristImageTopic", "--wrist-image-topic"), ("baseImageTopic", "--base-image-topic"),
                          ("stateTopic", "--state-topic"), ("armCommandTopic", "--arm-command-topic"),
                          ("gripperCommandTopic", "--gripper-command-topic")]:
            arguments.append(flag + "=" + str(config[key]))
        arguments.append("--root=" + str(root))
        if config["resume"]:
            arguments.append("--resume")
        with self.log_path.open("wb") as log:
            child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     cwd=str(Path.home()), start_new_session=True, env=environment)
        identity = None
        for _ in range(20):
            identity = process_identity(child.pid)
            if identity or child.poll() is not None:
                break
            time.sleep(0.05)
        if not identity:
            raise RuntimeError("采集器未能启动：" + self.log())
        metadata = {"pid": child.pid, "identity": identity, "config": dict(config, root=str(root))}
        self.manifest.write_text(json.dumps(metadata))
        for _ in range(10):
            result = self.status()
            if result["state"] == "idle":
                result["message"] = "采集器已就绪，点击开始 Episode 录入数据"
                return result
            if not self.owned(metadata):
                raise RuntimeError("采集器启动后退出：" + self.log())
            time.sleep(0.5)
        result["message"] = "采集器仍在初始化，请等待状态刷新"
        return result

    def finish(self):
        before = self.status()
        metadata = self.metadata()
        if not self.owned(metadata):
            raise RuntimeError("仅能结束由本应用启动且进程身份匹配的采集器")
        if before["state"] != "idle" or before["recording"] or before["pendingFrames"]:
            raise RuntimeError("请先保存或丢弃当前 Episode，待采集器空闲后再结束")
        metadata["finalizing"] = True
        self.manifest.write_text(json.dumps(metadata))
        # Signal only the recorder. Its video workers must be allowed to finalize.
        os.kill(metadata["pid"], signal.SIGINT)
        for _ in range(240):
            if not self.owned(metadata):
                if before["savedEpisodes"] and "Dataset finalized" not in self.log():
                    raise RuntimeError("采集器已退出，但未确认 finalize 成功，请检查日志：" + self.log())
                result = dict(before, state="stopped", managed=False, pid=0, log=self.log())
                result["message"] = "数据集已完成，采集器已退出" if before["savedEpisodes"] else "采集器已退出；尚未保存 Episode，未创建数据集"
                return result
            time.sleep(0.25)
        raise RuntimeError("采集器仍在完成数据集，未强制终止；请稍后刷新并检查日志")

    def execute(self, action, config=None):
        if action == "status":
            return self.status()
        if action == "launch":
            return self.launch(config)
        if action == "finish":
            return self.finish()
        if action not in ("start_episode", "save_episode", "discard_episode"):
            raise RuntimeError("不支持的采集操作")
        before = self.status()
        if before["state"] not in ("idle", "recording"):
            raise RuntimeError("采集器尚未就绪")
        message = self.services.call(action)
        if message is None:
            raise RuntimeError("采集器服务不可用")
        result = self.status()
        result["message"] = message
        return result


def main():
    services = None
    try:
        action, config_json = sys.argv[1:3]
        config = json.loads(config_json)
        cache = default_cache()
        cache.mkdir(parents=True, exist_ok=True)
        with (cache / "lerobot-recorder.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("另一项采集操作正在执行，请稍后刷新")
            services = RosServices()
            result = RecorderControl(services, cache).execute(action, config)
        print(PREFIX + json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as error:
        print(PREFIX + json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        sys.exit(1)
    finally:
        if services:
            with contextlib.suppress(Exception):
                services.close()


if __name__ == "__main__":
    main()
