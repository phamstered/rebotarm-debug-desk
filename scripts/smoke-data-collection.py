#!/usr/bin/env python3
"""Exercise the SSH adapter against a temporary mock recorder in an isolated ROS domain.
No existing recorder, robot process or motor-command topic is used.
"""
import argparse
from pathlib import Path
import re
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--host", default="jetson")
parser.add_argument("--ros-setup", default="Project/rebotarm-ros2-stack/install/setup.bash")
parser.add_argument("--domain", type=int, default=197, help="An unused non-production ROS domain (1-232)")
parser.add_argument("--ssh-port", type=int, default=22)
options = parser.parse_args()
if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@-]*", options.host):
    parser.error("invalid SSH host")
if not 1 <= options.domain <= 232 or not 1 <= options.ssh_port <= 65535:
    parser.error("invalid ROS domain or SSH port")
if not re.fullmatch(r"[A-Za-z0-9/._-]+", options.ros_setup) or any(part in ("", ".", "..") or part.startswith("-") for part in options.ros_setup.lstrip("/").split("/")):
    parser.error("invalid ROS setup path")
helper = (Path(__file__).resolve().parents[1] / "src-tauri/src/collection_remote.py").read_text()
mock_recorder = r'''
import argparse
import json
import rclpy
from rclpy.node import Node
from std_srvs.srv import Trigger

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task")
    config, _ = parser.parse_known_args()
    rclpy.init(args=[])
    node = Node("lerobot_recorder")
    state = dict(recording=False, pending_frames=0, saved_episodes=0, fps=20, task=config.task)
    def callback(action):
        def call(request, response):
            if action == "start_episode":
                state.update(recording=True, pending_frames=12)
            elif action == "save_episode":
                state.update(recording=False, pending_frames=0, saved_episodes=state["saved_episodes"] + 1)
            elif action == "discard_episode":
                state.update(recording=False, pending_frames=0)
            response.success = True
            response.message = json.dumps(state) if action == "status" else action + " complete"
            return response
        return call
    for action in ("status", "start_episode", "save_episode", "discard_episode"):
        node.create_service(Trigger, "~/"+action, callback(action))
    try:
        while rclpy.ok():
            rclpy.spin_once(node, timeout_sec=.1)
    except KeyboardInterrupt:
        pass
    finally:
        print("Dataset finalized", flush=True)
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()

if __name__ == "__main__":
    main()
'''
payload = "HELPER = " + repr(helper) + "\nMOCK = " + repr(mock_recorder) + "\n" + r'''
import json
import os
from pathlib import Path
import signal
import tempfile
import time

namespace = {"__name__": "isolated_collection_adapter"}
exec(HELPER, namespace)
with tempfile.TemporaryDirectory(prefix="robot-console-97-") as temporary:
    directory = Path(temporary)
    package = directory / "rebotarm_vla"
    package.mkdir()
    (package / "__init__.py").touch()
    (package / "lerobot_recorder.py").write_text(MOCK)
    backend = directory / "lerobot/datasets"
    backend.mkdir(parents=True)
    (directory / "lerobot/__init__.py").touch()
    (backend / "__init__.py").touch()
    (backend / "lerobot_dataset.py").write_text("class LeRobotDataset: pass\n")
    os.environ["PYTHONPATH"] = str(directory) + os.pathsep + os.environ.get("PYTHONPATH", "")
    ros = namespace["RosServices"]()
    control = namespace["RecorderControl"](ros, directory / "cache")
    config = dict(repoId="robot/isolated_test", root=str(directory / "dataset"), task="拾取 'cube' $(literal)",
                  fps=20, wristImageTopic="/isolated/wrist", baseImageTopic="", stateTopic="/isolated/state",
                  armCommandTopic="/isolated/arm", gripperCommandTopic="/isolated/gripper",
                  pythonPath="/usr/bin/python3", resume=False)
    steps = []
    try:
        for action in ("launch", "start_episode", "save_episode", "start_episode", "discard_episode", "finish"):
            result = control.execute(action, config if action == "launch" else None)
            steps.append(dict(action=action, state=result["state"], frames=result["pendingFrames"], saved=result["savedEpisodes"]))
        assert steps[1]["state"] == "recording" and steps[1]["frames"] == 12
        assert steps[2]["saved"] == 1
        assert steps[-1]["state"] == "stopped"
        print("ISOLATED_ROS_TEST=" + json.dumps(steps), flush=True)
    finally:
        metadata = control.metadata()
        if control.owned(metadata):
            os.kill(metadata["pid"], signal.SIGINT)
            for _ in range(40):
                if not control.owned(metadata):
                    break
                time.sleep(.1)
        ros.close()
'''
remote = "bash -lc " + shlex.quote("set -e; cd \"$HOME\"; source /opt/ros/humble/setup.bash; source " + shlex.quote(options.ros_setup) + "; export ROS_DOMAIN_ID=" + str(options.domain) + "; python3 -")
result = subprocess.run(["ssh", "-p", str(options.ssh_port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", options.host, remote], input=payload, text=True, capture_output=True, timeout=120)
print(result.stdout)
print(result.stderr)
raise SystemExit(result.returncode)
