#!/usr/bin/env python3
"""Read-only ROS 2 Humble motion recorder; offline analysis uses only stdlib.

No control publishers, action goals, cancellation, controller switches or parameter writes.
"""
import argparse
import bisect
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import queue
import signal
import statistics
import threading
import time
import uuid

JOINTS = [f"joint{i}" for i in range(1, 7)]
TERMINAL = (4, 5, 6)
TOPICS = {
    "command": "/stm32/joint_commands", "joint": "/stm32/joint_states",
    "hardware": "/stm32/status", "controller": "/arm_trajectory_controller/controller_state",
    "plan": "/display_planned_path", "move_status": "/move_action/_action/status",
    "trajectory_status": "/arm_trajectory_controller/follow_joint_trajectory/_action/status",
    "move_feedback": "/move_action/_action/feedback", "log": "/rosout",
}


def seconds(stamp):
    return stamp.get("sec", 0) + stamp.get("nanosec", 0) / 1e9


def finite(values):
    return all(isinstance(v, (float, int)) and math.isfinite(v) for v in values)


def json_safe(value):
    """Preserve invalid sensor values as null instead of losing the entire file."""
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def percentile(values, fraction):
    return sorted(values)[min(len(values)-1, int((len(values)-1)*fraction))] if values else None


def cadence(times):
    dt = [(b-a)*1000 for a, b in zip(times, times[1:])]
    return {"count": len(times), "median_ms": statistics.median(dt) if dt else None,
            "p99_ms": percentile(dt, .99), "max_ms": max(dt, default=None),
            "gaps_over_20ms": sum(v > 20 for v in dt), "gaps_over_50ms": sum(v > 50 for v in dt),
            "non_increasing": sum(v <= 0 for v in dt)}


def trajectory_metrics(trajectory):
    points = trajectory.get("points", [])
    names = trajectory.get("joint_names", [])
    if not points:
        return {"points": 0, "valid": False, "reason": "empty trajectory"}
    t = [seconds(p.get("time_from_start", {})) for p in points]
    valid = len(set(names)) == len(names) and bool(names) and finite(t)
    valid = valid and all(len(p.get("positions", [])) == len(names) and finite(p["positions"]) for p in points)
    valid = valid and all(b > a for a, b in zip(t, t[1:])) and t[0] >= 0
    for field in ("velocities", "accelerations"):
        valid = valid and all(len(p.get(field, [])) in (0, len(names)) and finite(p.get(field, [])) for p in points)
    result = {"points": len(points), "duration_s": t[-1], "valid": valid,
              "full_velocity": all(len(p.get("velocities", [])) == len(names) for p in points),
              "full_acceleration": all(len(p.get("accelerations", [])) == len(names) for p in points)}
    if not valid:
        return result
    result.update(max_velocity=max((abs(v) for p in points for v in p.get("velocities", [])), default=None),
                  max_acceleration=max((abs(v) for p in points for v in p.get("accelerations", [])), default=None),
                  interior_stopped_points=sum(bool(p.get("velocities")) and max(map(abs, p["velocities"])) < 1e-5 for p in points[1:-1]))
    result["joint_path_length_rad"] = [sum(abs(b["positions"][j]-a["positions"][j]) for a, b in zip(points, points[1:])) for j in range(len(names))]
    # Knot finite differences are diagnostics, NOT a bound on continuous jerk.
    if result["full_acceleration"]:
        result["max_knot_acceleration_slope_rad_s3"] = max((abs(b["accelerations"][j]-a["accelerations"][j])/(tb-ta) for a, b, ta, tb in zip(points, points[1:], t, t[1:]) for j in range(len(names))), default=0)
    return result


class Writer:
    """Single background writer; bounded queue, bytes and line size, explicit loss."""
    def __init__(self, path, max_bytes, depth=4096):
        self.path, self.max_bytes = path, max_bytes
        self.queue = queue.Queue(maxsize=depth)
        self.stop = threading.Event()
        self.dropped = 0
        self.reason = ""
        self.bytes = 0
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def put(self, event):
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            self.dropped += 1
            self.reason = "queue_full"
            self.stop.set()

    def run(self):
        try:
            with self.path.open("x", encoding="utf-8", buffering=65536) as out:
                while True:
                    event = self.queue.get()
                    if event is None:
                        break
                    line = json.dumps(json_safe(event), ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
                    size = len(line.encode("utf-8"))
                    if size > 4*1024*1024 or self.bytes + size > self.max_bytes:
                        self.dropped += 1
                        self.reason = "size_limit"
                        self.stop.set()
                        continue
                    out.write(line)
                    self.bytes += size
        except Exception as exc:
            self.error = str(exc)
            self.reason = "writer_error"
            self.stop.set()

    def close(self):
        while self.thread.is_alive():
            try:
                self.queue.put(None, timeout=.1)
                break
            except queue.Full:
                pass
        self.thread.join()


def records(path, errors=None):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or not finite([event.get("t", float("nan"))]):
                    raise ValueError("missing finite monotonic time")
                yield event
            except (ValueError, TypeError):
                if errors is not None:
                    errors["invalid_lines"] += 1


class Stats:
    def __init__(self):
        self.times = defaultdict(list)
        self.source_times = defaultdict(list)
        self.publishers = defaultdict(Counter)
        self.errors = {j: [] for j in JOINTS}
        self.actual_velocity = {j: [] for j in JOINTS}
        self.desired_velocity = {j: [] for j in JOINTS}
        self.command_velocity_max = 0.
        self.moving_reference_samples = 0
        self.command_count = 0
        self.sequence = {}
        self.sequence_gaps = self.sequence_backward = 0
        self.sequence_unattributed = 0
        self.sequence_attributed = 0
        self.faults = Counter()
        self.modes = Counter()
        self.invalid_vectors = 0
        self.max_kp = [0.]*6
        self.max_kd = [0.]*6

    def add(self, event):
        kind, t, data = event.get("kind"), event["t"], event.get("data", {})
        if kind not in TOPICS:
            return
        gid = event.get("publisher_gid", "unknown")
        # Cadence is per publisher: do not mix independent writers' sequences/times.
        key = kind + ":" + gid
        self.times[key].append(t)
        stamp = data.get("header", {}).get("stamp")
        if stamp and seconds(stamp) != 0:
            self.source_times[key].append(seconds(stamp))
        self.publishers[kind][gid] += 1
        if kind == "command":
            v = data.get("velocity", [])[:6]
            if len(v) != 6 or not finite(v):
                self.invalid_vectors += 1
                return
            self.command_count += 1
            self.command_velocity_max = max(self.command_velocity_max, max(map(abs, v)))
            for field, dest in (("kp", self.max_kp), ("kd", self.max_kd)):
                for i, x in enumerate(data.get(field, [])[:6]):
                    if finite([x]):
                        dest[i] = max(dest[i], abs(x))
            seq = data.get("sequence")
            attributed = bool(gid) and gid != "unavailable" and gid != "unknown"
            self.sequence_unattributed += not attributed
            self.sequence_attributed += attributed
            if attributed and isinstance(seq, int) and gid in self.sequence:
                delta = (seq-self.sequence[gid]) & 0xffffffff
                if 1 < delta < 0x80000000:
                    # Firmware reserves sequence 0 and skips it on wrap.
                    self.sequence_gaps += delta-1-int(seq < self.sequence[gid])
                elif delta == 0 or delta >= 0x80000000:
                    self.sequence_backward += 1
            if attributed and isinstance(seq, int):
                self.sequence[gid] = seq
        elif kind == "controller":
            names = data.get("joint_names", [])
            if len(set(names)) != len(names):
                self.invalid_vectors += 1
                return
            desired, actual = data.get("desired", {}), data.get("actual", {})
            if any(len(p.get("positions", [])) != len(names) or not finite(p["positions"]) for p in (desired, actual)):
                self.invalid_vectors += 1
                return
            arm_v = []
            for j in JOINTS:
                if j not in names:
                    self.invalid_vectors += 1
                    continue
                i = names.index(j)
                self.errors[j].append(desired["positions"][i]-actual["positions"][i])
                for point, dest in ((desired, self.desired_velocity), (actual, self.actual_velocity)):
                    if len(point.get("velocities", [])) == len(names) and finite(point["velocities"]):
                        dest[j].append(point["velocities"][i])
                if len(desired.get("velocities", [])) == len(names) and finite(desired["velocities"]):
                    arm_v.append(desired["velocities"][i])
            self.moving_reference_samples += bool(arm_v) and max(map(abs, arm_v)) > .005
        elif kind == "hardware":
            self.faults[str(data.get("fault_code"))] += 1
            self.modes[str(data.get("mode"))] += 1

    def report(self):
        return {"receive_cadence": {k: cadence(v) for k, v in self.times.items()},
                "source_stamp_cadence": {k: cadence(v) for k, v in self.source_times.items()},
                "publishers": {k: dict(v) for k, v in self.publishers.items()},
                "tracking": {j: {"samples": len(v), "rms_error_rad": math.sqrt(sum(x*x for x in v)/len(v)) if v else None,
                                 "p99_abs_error_rad": percentile(list(map(abs, v)), .99), "max_abs_error_rad": max(map(abs, v), default=None),
                                 "max_desired_velocity": max(map(abs, self.desired_velocity[j]), default=None),
                                 "max_actual_velocity": max(map(abs, self.actual_velocity[j]), default=None)} for j, v in self.errors.items()},
                "command_samples": self.command_count, "command_max_abs_velocity": self.command_velocity_max,
                "moving_reference_samples": self.moving_reference_samples, "max_kp": self.max_kp, "max_kd": self.max_kd,
                "sequence_missing_observed": self.sequence_gaps if self.sequence_attributed else None,
                "sequence_non_forward": self.sequence_backward if self.sequence_attributed else None,
                "sequence_unattributed_samples": self.sequence_unattributed,
                "fault_codes": dict(self.faults), "hardware_modes": dict(self.modes), "invalid_vectors": self.invalid_vectors}


def analyze(directory):
    directory = Path(directory)
    errors = Counter()
    meta_path = directory/"metadata.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    raw = directory/"events.jsonl"
    goals = {}
    plans = []
    last_t = 0
    for e in records(raw, errors):
        last_t = max(last_t, e["t"])
        data = e.get("data", {})
        if e.get("kind") == "move_status":
            for status in data.get("status_list", []):
                info = status["goal_info"]
                goal_id = bytes(info["goal_id"]["uuid"]).hex()
                # Transient-local terminal statuses from before capture are not new moves.
                preexisting = seconds(info["stamp"]) < meta.get("start_ros_ns", 0)/1e9
                if goal_id not in goals and (preexisting or status["status"] in TERMINAL):
                    continue
                g = goals.setdefault(goal_id, {"goal_id": goal_id, "start_s": e["t"], "end_s": None, "status": status["status"]})
                g["status"] = status["status"]
                if status["status"] in TERMINAL and g["end_s"] is None:
                    g["end_s"] = e["t"]
        elif e.get("kind") == "move_result":
            result = data.get("result", {})
            plans.append({"goal_id": data.get("goal_id"), "action_status": data.get("status"),
                          "moveit_code": result.get("error_code", {}).get("val"),
                          "planned": trajectory_metrics(result.get("planned_trajectory", {}).get("joint_trajectory", {})),
                          "executed": trajectory_metrics(result.get("executed_trajectory", {}).get("joint_trajectory", {}))})
        elif e.get("kind") == "plan":
            for tr in data.get("trajectory", []):
                plans.append({"source": "display_planned_path", "t": e["t"], "planned": trajectory_metrics(tr.get("joint_trajectory", {}))})
    windows = sorted(goals.values(), key=lambda g: g["start_s"])
    stats = [Stats() for _ in windows]
    starts = [w["start_s"] for w in windows]
    overall = Stats()
    for e in records(raw):
        overall.add(e)
        index = bisect.bisect_right(starts, e["t"])-1
        if index >= 0 and e["t"] <= (windows[index]["end_s"] if windows[index]["end_s"] is not None else last_t):
            stats[index].add(e)
    summary = {"schema_version": 1, "metadata": meta, "invalid_lines": errors["invalid_lines"],
               "duration_s": last_t, "overall": overall.report(), "trajectories": plans,
               "motions": [{**w, "complete_window": w["end_s"] is not None, "metrics": s.report()} for w, s in zip(windows, stats)]}
    findings = []
    counts = summary["overall"]["publishers"]
    for kind in ("command", "joint", "hardware", "controller"):
        if not counts.get(kind):
            findings.append(f"缺少 {kind} 数据，相关结论不可用；检查 ROS_DOMAIN_ID、Topic 与 QoS。")
    if not windows:
        findings.append("没有完整捕获开始的 MoveGroup 运动；本报告可能仅覆盖静止或中途启动采集，不能解释运动抖动。")
    for w, stat in zip(windows, stats):
        r = stat.report()
        if r["moving_reference_samples"] and r["command_samples"] and r["command_max_abs_velocity"] < 1e-8:
            findings.append(f"运动 {w['goal_id'][:8]}：参考速度非零，但采到的 STM32 目标速度全部为零；检查速度前馈通道。此处为窗口统计，仍需对齐原始时间轴确认。")
    if meta.get("writer_dropped", 0) or meta.get("writer_error") or meta.get("capture_error") or errors["invalid_lines"] or not meta.get("finalized"):
        findings.append("采集不完整/存在丢样或异常行；不能把缺失样本直接解释为控制器断流。")
    if summary["overall"]["sequence_missing_observed"]:
        findings.append("接收侧发现 sequence 跳号；BEST_EFFORT 丢包、采集延迟或发送端均可能导致，不能直接认定 STM32 也丢包。")
    if summary["overall"]["sequence_unattributed_samples"]:
        findings.append("当前 rclpy 未提供逐帧发布者 GID：未归属指令不计算 sequence 跳号；unavailable 下的间隔可能混有多个发布者，发布端身份/QoS 见 graph 原始事件。")
    findings.append("接收间隔包含 DDS/调度/采集开销；源时间仅做同发布者间隔统计，不跨 MCU 与 Jetson 时钟直接相减。")
    findings.append("TOTG 中间采样点与结点加速度差分不等于逐点停顿或连续 jerk 上界；此报告不自动调整增益/速度。")
    summary["findings"] = findings
    (directory/"summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False)+"\n")
    lines = ["# 运动监控报告", "", f"采集时长：{last_t:.2f} s；运动窗口：{len(windows)}；异常行：{errors['invalid_lines']}", "", "## 观察与边界", ""]
    lines += ["- " + x for x in findings]
    lines += ["", "## 规划轨迹", "", "|来源/Goal|点数|时长 s|最大速度 rad/s|内部全关节停点|", "|---|---:|---:|---:|---:|"]
    for p in plans:
        m = p["planned"]
        lines.append(f"|{p.get('goal_id', p.get('source'))}|{m['points']}|{m.get('duration_s')}|{m.get('max_velocity')}|{m.get('interior_stopped_points')}|")
    lines += ["", "## 各运动跟踪误差", "", "|Goal|关节|RMS rad|最大绝对误差 rad|", "|---|---|---:|---:|"]
    for w, s in zip(windows, stats):
        for j, m in s.report()["tracking"].items():
            lines.append(f"|{w['goal_id'][:8]}|{j}|{m['rms_error_rad']}|{m['max_abs_error_rad']}|")
    lines += ["", "完整接收/源时间间隔、发布者、sequence、故障、增益与速度统计见 summary.json；events.jsonl 保留原始数据。", ""]
    (directory/"summary.md").write_text("\n".join(lines))
    return summary


def capture(args):
    # Lazy imports keep --help and offline analysis available on a Mac without ROS.
    import os
    import rclpy
    from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
    from rosidl_runtime_py.convert import message_to_ordereddict
    from action_msgs.msg import GoalStatusArray
    from control_msgs.msg import JointTrajectoryControllerState
    from microros_stm32h723_bridge.msg import JointCommand, HardwareStatus
    from moveit_msgs.action import MoveGroup
    from moveit_msgs.msg import DisplayTrajectory
    from rcl_interfaces.msg import Log
    from rcl_interfaces.srv import GetParameters
    from sensor_msgs.msg import JointState

    directory = Path(args.output).expanduser()
    directory.mkdir(parents=True, exist_ok=False)
    writer = Writer(directory/"events.jsonl", int(args.max_mb*1024*1024))
    rclpy.init(args=[])
    node = rclpy.create_node("motion_monitor_"+uuid.uuid4().hex[:8], enable_rosout=False)
    start = time.monotonic_ns()
    meta = {"schema_version": 1, "start_utc": datetime.now(timezone.utc).isoformat(),
            "start_monotonic_ns": start, "start_ros_ns": node.get_clock().now().nanoseconds,
            "ros_domain_id": os.environ.get("ROS_DOMAIN_ID", "0"), "topics": TOPICS,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "requested_duration_s": args.duration, "max_mb": args.max_mb, "finalized": False,
            "nonfinite_encoded_as_null": True}
    (directory/"metadata.json").write_text(json.dumps(meta, indent=2)+"\n")
    seen = Counter()
    subscriptions, clients, futures = [], [], []
    result_ids = set()
    requested_ids = set()
    signal_stop = threading.Event()
    old_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    for sig in old_handlers:
        signal.signal(sig, lambda *_: signal_stop.set())

    def emit(kind, data, gid=""):
        writer.put({"t": (time.monotonic_ns()-start)/1e9, "kind": kind, "publisher_gid": gid, "data": data})

    result_client = node.create_client(MoveGroup.Impl.GetResultService, "/move_action/_action/get_result")
    clients.append(result_client)

    def get_result(goal_id):
        if not result_client.service_is_ready():
            return
        req = MoveGroup.Impl.GetResultService.Request()
        req.goal_id.uuid = list(bytes.fromhex(goal_id))
        requested_ids.add(goal_id)
        future = result_client.call_async(req)
        futures.append(future)
        def done(f):
            try:
                response = f.result()
                emit("move_result", {"goal_id": goal_id, **message_to_ordereddict(response)})
            except Exception as exc:
                emit("diagnostic", {"result_error": str(exc), "goal_id": goal_id})
        future.add_done_callback(done)

    def callback(kind):
        def receive(msg, info=None):
            if kind == "log" and not (msg.level >= 30 and any(s in msg.name.lower() for s in ("move", "trajectory", "controller", "hardware", "micro"))):
                return
            seen[kind] += 1
            data = message_to_ordereddict(msg)
            gid = bytes(info.publisher_gid).hex() if info is not None and hasattr(info, "publisher_gid") else "unavailable"
            emit(kind, data, gid)
            if kind == "move_status":
                for item, serialized in zip(msg.status_list, data["status_list"]):
                    # Never request old cached goals; action get_result is read-only.
                    if item.status in TERMINAL and seconds(serialized["goal_info"]["stamp"]) >= meta["start_ros_ns"]/1e9:
                        result_ids.add(bytes(item.goal_info.goal_id.uuid).hex())
        return receive

    fast = QoSProfile(depth=200, reliability=ReliabilityPolicy.BEST_EFFORT, durability=DurabilityPolicy.VOLATILE)
    latched = QoSProfile(depth=20, reliability=ReliabilityPolicy.RELIABLE, durability=DurabilityPolicy.TRANSIENT_LOCAL)
    classes = {"command": JointCommand, "joint": JointState, "hardware": HardwareStatus,
               "controller": JointTrajectoryControllerState, "plan": DisplayTrajectory,
               "move_status": GoalStatusArray, "trajectory_status": GoalStatusArray,
               "move_feedback": MoveGroup.Impl.FeedbackMessage, "log": Log}
    for kind, cls in classes.items():
        subscriptions.append(node.create_subscription(cls, TOPICS[kind], callback(kind), latched if kind.endswith("status") else fast))

    param_sets = {
        "/controller_manager": ["update_rate"],
        "/arm_trajectory_controller": ["command_interfaces", "state_interfaces", "interpolation_method", "state_publish_rate", "open_loop_control"],
        "/move_group": ["ompl.request_adapters", "ompl.resample_dt", "moveit_manage_controllers"] + [f"robot_description_planning.joint_limits.{j}.{key}" for j in JOINTS for key in ("max_velocity", "max_acceleration", "max_jerk")],
    }
    param_done = set()
    for name in param_sets:
        clients.append(node.create_client(GetParameters, name+"/get_parameters"))

    def snapshot():
        endpoints = {}
        for kind, topic in TOPICS.items():
            endpoints[kind] = [{"node": p.node_namespace.rstrip("/")+"/"+p.node_name,
                                "gid": bytes(p.endpoint_gid).hex(), "type": p.topic_type,
                                "qos": str(p.qos_profile)} for p in node.get_publishers_info_by_topic(topic)]
        emit("graph", endpoints)
        for (name, keys), client in zip(param_sets.items(), clients[1:]):
            if name in param_done or not client.service_is_ready():
                continue
            param_done.add(name)
            request = GetParameters.Request()
            request.names = keys
            f = client.call_async(request)
            futures.append(f)
            def done(f, name=name, keys=keys):
                try:
                    emit("parameters", {"node": name, "keys": keys, "response": message_to_ordereddict(f.result())})
                except Exception as exc:
                    emit("diagnostic", {"parameter_error": str(exc), "node": name})
            f.add_done_callback(done)

    print(f"OUTPUT={directory.resolve()}\n只读采集已启动；等待 Topic 发现。Ctrl+C 仅停止采集，不会停止机械臂。", flush=True)
    print("请等待 samples 中 command/joint/hardware/controller 均有数据后，再执行运动。", flush=True)
    timer = node.create_timer(5, snapshot)
    progress = node.create_timer(5, lambda: print(f"{(time.monotonic_ns()-start)/1e9:.0f}s samples={dict(seen)} dropped={writer.dropped}", flush=True))
    reason = "duration"
    try:
        while (time.monotonic_ns()-start)/1e9 < args.duration and rclpy.ok():
            if writer.stop.is_set() or signal_stop.is_set():
                reason = writer.reason or "signal"
                break
            rclpy.spin_once(node, timeout_sec=.05)
            for goal_id in result_ids-requested_ids:
                get_result(goal_id)
        # Drain only already requested read-only responses. No motion/cancel calls.
        deadline = time.monotonic()+1
        while rclpy.ok() and time.monotonic() < deadline and any(not f.done() for f in futures):
            rclpy.spin_once(node, timeout_sec=.05)
    except Exception as exc:
        reason = "capture_error"
        meta["capture_error"] = str(exc)
    finally:
        node.destroy_timer(timer)
        node.destroy_timer(progress)
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        writer.close()
        meta.update(finalized=True, stop_reason=reason, writer_dropped=writer.dropped,
                    writer_error=writer.error, bytes=writer.bytes, samples=dict(seen),
                    end_utc=datetime.now(timezone.utc).isoformat())
        (directory/"metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2)+"\n")
    analyze(directory)
    print(f"结束原因：{reason}；丢样：{writer.dropped}；错误：{writer.error or meta.get('capture_error') or '无'}", flush=True)
    print(f"报告：{directory.resolve()}/summary.md\n请保留整个目录（events.jsonl、metadata.json、summary.json、summary.md）。", flush=True)
    return 1 if writer.error or writer.dropped or meta.get("capture_error") else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    record = sub.add_parser("record", help="Jetson 上只读订阅；不发控制指令")
    record.add_argument("--duration", type=float, default=300, help="采集秒数，默认 300")
    record.add_argument("--max-mb", type=float, default=256, help="原始文件上限 MiB，默认 256")
    record.add_argument("--output", default=str(Path.home()/"motion-captures"/(datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+uuid.uuid4().hex[:6])))
    offline = sub.add_parser("analyze", help="离线重算报告，不需要 ROS")
    offline.add_argument("directory")
    args = parser.parse_args()
    if args.mode == "analyze":
        analyze(Path(args.directory).expanduser())
        print(str(Path(args.directory).expanduser()/"summary.md"))
        return 0
    if not math.isfinite(args.duration) or not 0 < args.duration <= 3600 or not math.isfinite(args.max_mb) or not 1 <= args.max_mb <= 1024:
        parser.error("duration 必须在 (0,3600] 秒；max-mb 必须在 [1,1024] MiB")
    try:
        return capture(args)
    except ImportError as exc:
        parser.exit(2, f"缺少 ROS 2 依赖：{exc}；请在 Jetson source ROS 与机器人 overlay 后运行。\n")
    except (OSError, ValueError) as exc:
        parser.exit(2, f"采集/分析失败：{exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
