import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope, MotionLogEntry, TcpPose } from "./types";
import type { CustomPosition } from "./positionLogic";
import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME } from "./positionLogic";
import { validateMotionGroup, type MotionGroup } from "./motionGroupsLogic";

export type PositionMotionPhase = "idle" | "validating" | "planning" | "executing" | "verifying" | "waiting" | "paused" | "canceling" | "stopping" | "stop_failed" | "succeeded" | "failed" | "canceled";
export type MotionGroupProgress = { id: string; index: number; count: number; phase: "preparing" | "moving" | "holding" | "paused"; elapsed: number };
export type PositionMotionState = { commandId: string; label: string; phase: PositionMotionPhase; message: string; code?: number; recommendedDuration?: number; group?: MotionGroupProgress };
export const positionMotionBusy = (phase: PositionMotionPhase) => !["idle", "succeeded", "failed", "canceled"].includes(phase);
export type PositionMotionControls = {
  logs: MotionLogEntry[];
  recordLog(phase: string, message: string, level?: MotionLogEntry["level"], commandId?: string): void;
  state: PositionMotionState;
  homePositions: number[];
  gripper?: { supported: boolean; available: boolean; message: string; lower: number; upper: number; position?: number; fresh: boolean };
  reason: string;
  busy: boolean;
  armed: boolean;
  setArmed(value: boolean): void;
  execute(position: CustomPosition | "home"): Promise<void>;
  jointRotationReason: string;
  executeJoint(jointName: string, position: number): Promise<void>;
  jointTargetsReason: string;
  executeJoints(targets: Record<string, number>, duration: number): Promise<void>;
  tcpPoseReason?: string;
  executeTcpPose?(pose: TcpPose, duration?: number, gripperPosition?: number): Promise<void>;
  groupReason?: string;
  groupActionBusy?: boolean;
  executeGroup?(group: MotionGroup): Promise<void>;
  pauseGroup?(): Promise<void>;
  resumeGroup?(): Promise<void>;
  cancel(): Promise<void>;
};
const idle: PositionMotionState = { commandId: "", label: "", phase: "idle", message: "" };
const phases: PositionMotionPhase[] = ["validating", "planning", "executing", "verifying", "waiting", "paused", "canceling", "stopping", "stop_failed", "succeeded", "failed", "canceled"];

export function usePositionMotion(bridge: Pick<BridgeClient, "request" | "onMessage">, connected: boolean, profileKey: string, localBlock: string): PositionMotionControls {
  const [logs, setLogs] = useState<MotionLogEntry[]>([]);
  const localSequence = useRef(0);
  const logContext = useMemo(() => ({ valid: connected }), [bridge, connected, profileKey]);
  useEffect(() => {
    logContext.valid = connected;
    return () => { logContext.valid = false; };
  }, [logContext, connected]);
  const recordLog = useCallback((phase: string, message: string, level: MotionLogEntry["level"] = "info", commandId = "") => {
    if (!logContext.valid) return; // Late TCP completions cannot contaminate a new session.
    const entry: MotionLogEntry = { seq: --localSequence.current, timestamp_ms: Date.now(), command_id: commandId, phase, message: message.slice(0, 8192), level };
    setLogs((value) => [...value, entry].slice(-5000));
  }, [logContext]);
  const [state, setState] = useState<PositionMotionState>(idle);
  const initialInfo = { available: false, message: "等待 MoveIt 状态", home: [] as number[], busy: false, tcpPose: false, jointRotation: false, jointTargets: false, duration: false, group: false, durationMessage: "", gripper: { supported: false, available: false, message: "当前 Bridge 不支持夹爪，请更新 Bridge", lower: 0, upper: 0, position: undefined as number | undefined, fresh: false } };
  const [info, setInfo] = useState(initialInfo);
  const [armed, setArmed] = useState(false);
  const generation = useRef(0);
  const active = useRef("");
  const locked = useRef(false);
  const activeGroup = useRef<MotionGroup | null>(null);
  const groupAction = useRef(false);
  const [groupActionBusy, setGroupActionBusy] = useState(false);
  const context = useRef({ connected, profileKey, localBlock, armed, info });
  context.current = { connected, profileKey, localBlock, armed, info };

  useEffect(() => {
    const current = ++generation.current;
    active.current = ""; locked.current = false;
    activeGroup.current = null; groupAction.current = false; setGroupActionBusy(false);
    setArmed(false); setState(idle); setInfo(initialInfo); setLogs([]);
    let logSession = "", logCursor = 0;
    if (!connected) return;
    const abort = new AbortController();
    let polling = false, pollError = "";
    let gripperExpiry: number | undefined, liveExpiry: number | undefined;
    let livePosition: number | undefined, liveAt = -Infinity;
    let snapshotPosition: number | undefined, snapshotUntil = -Infinity;
    let subscribedGripper = false;
    const liveFresh = () => livePosition !== undefined && performance.now() - liveAt < 1000;
    const clearLive = () => {
      livePosition = undefined; liveAt = -Infinity;
      if (liveExpiry !== undefined) window.clearTimeout(liveExpiry);
      setInfo((value) => ({ ...value, gripper: { ...value.gripper,
        available: value.gripper.available && performance.now() < snapshotUntil,
        fresh: performance.now() < snapshotUntil, position: performance.now() < snapshotUntil ? snapshotPosition : undefined } }));
    };
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const requestedAt = performance.now();
        const reply = await bridge.request({ op: "position_motion_info", motion_log_session: logSession, motion_log_after: logCursor }, 3000, abort.signal);
        if (generation.current !== current || abort.signal.aborted) return;
        if (reply.op !== "position_motion_info") throw new Error("Bridge 不支持 MoveIt 点位执行，请更新 Bridge");
        if (pollError) recordLog("connection", "规划状态查询已恢复");
        pollError = "";
        if (typeof reply.motion_log_session === "string" && Array.isArray(reply.motion_logs)) {
          const restarted = Boolean(logSession && logSession !== reply.motion_log_session);
          logSession = reply.motion_log_session;
          logCursor = reply.motion_log_cursor ?? 0;
          if (restarted) recordLog("bridge", "Bridge 已重启，日志序列重新开始", "warn");
          if (reply.motion_log_truncated) recordLog("bridge", "日志同步窗口已溢出，部分历史请查看 Jetson Bridge 原始日志", "warn");
          if (reply.motion_logs.length) setLogs((value) => [...value, ...reply.motion_logs!].slice(-5000));
        }
        if (gripperExpiry !== undefined) window.clearTimeout(gripperExpiry);
        const age = reply.gripper_feedback_age_ms === undefined ? 0 : typeof reply.gripper_feedback_age_ms === "number" && Number.isFinite(reply.gripper_feedback_age_ms) && reply.gripper_feedback_age_ms >= 0 ? reply.gripper_feedback_age_ms : 1000;
        // Include request transit time conservatively; a slow info request cannot renew old feedback.
        const remaining = Math.max(0, 1000 - age - (performance.now() - requestedAt));
        const gripperFresh = remaining > 0 && reply.gripper_supported === true && reply.gripper_joint_name === GRIPPER_JOINT_NAME && reply.gripper_feedback_fresh === true;
        if (reply.gripper_supported !== true || reply.gripper_joint_name !== GRIPPER_JOINT_NAME ||
            !Number.isFinite(reply.gripper_lower) || !Number.isFinite(reply.gripper_upper) ||
            (livePosition !== undefined && (livePosition < reply.gripper_lower! || livePosition > reply.gripper_upper!))) {
          livePosition = undefined; liveAt = -Infinity;
          if (liveExpiry !== undefined) window.clearTimeout(liveExpiry);
        }
        snapshotPosition = gripperFresh && typeof reply.gripper_position === "number" && Number.isFinite(reply.gripper_position) ? reply.gripper_position : undefined;
        snapshotUntil = gripperFresh && snapshotPosition !== undefined ? performance.now() + remaining : -Infinity;
        if (reply.gripper_supported === true && reply.gripper_joint_name === GRIPPER_JOINT_NAME && !subscribedGripper) {
          subscribedGripper = true;
          void bridge.request({ op: "subscribe", topic: "/robot_feedback/joint_states", type: "sensor_msgs/msg/JointState" }, 3000, abort.signal).catch(() => {
            if (generation.current === current && !abort.signal.aborted) subscribedGripper = false;
          });
        }
        if (gripperFresh) gripperExpiry = window.setTimeout(() => {
          if (generation.current !== current || abort.signal.aborted) return;
          setInfo((value) => ({ ...value, gripper: { ...value.gripper, available: liveFresh() && value.gripper.available, fresh: liveFresh(), position: liveFresh() ? livePosition : undefined, message: liveFresh() ? value.gripper.message : "夹爪反馈已过期" } }));
        }, remaining);
        const home = Array.isArray(reply.home_positions) && reply.home_positions.length === 6 && reply.home_positions.every(Number.isFinite) ? reply.home_positions : [];
        setInfo({ available: reply.available === true, message: reply.message || "", home, busy: reply.busy === true,
          tcpPose: reply.tcp_pose_supported === true, jointRotation: reply.joint_rotation_supported === true, jointTargets: reply.joint_targets_supported === true, duration: reply.motion_duration_supported === true, group: reply.motion_group_supported === true, durationMessage: reply.motion_duration_message || "",
          gripper: { supported: reply.gripper_supported === true && reply.gripper_joint_name === GRIPPER_JOINT_NAME,
            available: reply.gripper_supported === true && reply.gripper_joint_name === GRIPPER_JOINT_NAME && reply.gripper_available === true && gripperFresh &&
              Number.isFinite(reply.gripper_lower) && Number.isFinite(reply.gripper_upper) && reply.gripper_lower! < reply.gripper_upper!,
            message: reply.gripper_supported === true ? reply.gripper_message || "夹爪反馈或控制器不可用" : "当前 Bridge 不支持夹爪，请更新 Bridge",
            lower: reply.gripper_lower ?? 0, upper: reply.gripper_upper ?? 0,
            position: liveFresh() ? livePosition : snapshotPosition,
            fresh: liveFresh() || gripperFresh } });
        if (active.current && reply.command_id !== active.current && reply.busy === false) {
          setState((value) => {
            if (value.phase !== "stop_failed") return value;
            locked.current = false;
            return { ...value, phase: "failed", message: "服务端确认没有受理该运动，未重复下发" };
          });
        }
      } catch (e) {
        if (generation.current === current && !abort.signal.aborted) {
          const message = String(e instanceof Error ? e.message : e);
          if (message !== pollError) recordLog("connection", `规划状态查询失败：${message}`, "error");
          pollError = message;
          setInfo((value) => ({ ...value, available: false, message, gripper: { ...value.gripper, available: false, fresh: false, position: undefined } }));
        }
      } finally { polling = false; }
    };
    const off = bridge.onMessage((message) => {
      if (generation.current !== current || abort.signal.aborted) return;
      if (message.op === "topic_message" && message.topic === "/robot_feedback/joint_states") {
        const g = context.current.info.gripper;
        if (!g.supported) return;
        const data = message.data as { name?: unknown; position?: unknown } | null;
        const names = data?.name, values = data?.position;
        if (!Array.isArray(names) || !Array.isArray(values) || names.length !== values.length ||
            names.some((name) => typeof name !== "string" || !name) || new Set(names).size !== names.length) { clearLive(); return; }
        const position = values[names.indexOf(GRIPPER_JOINT_NAME)];
        if (typeof position !== "number" || !Number.isFinite(position) || position < g.lower || position > g.upper) { clearLive(); return; }
        livePosition = position; liveAt = performance.now();
        if (liveExpiry !== undefined) window.clearTimeout(liveExpiry);
        liveExpiry = window.setTimeout(() => {
          if (generation.current === current && !abort.signal.aborted) clearLive();
        }, 1000);
        setInfo((value) => ({ ...value, gripper: { ...value.gripper, fresh: true, position } }));
        return;
      }
      if (message.op !== "position_motion" || message.command_id !== active.current) return;
      const eventId = active.current;
      const phase = message.motion_phase as PositionMotionPhase;
      if (!phases.includes(phase)) return;
      const expected = activeGroup.current;
      const group = expected && message.group_id === expected.id && message.group_count === expected.steps.length &&
        Number.isInteger(message.group_index) && message.group_index! >= 0 && message.group_index! < expected.steps.length &&
        ["preparing", "moving", "holding", "paused"].includes(message.group_phase ?? "") &&
        typeof message.group_elapsed_s === "number" && Number.isFinite(message.group_elapsed_s) && message.group_elapsed_s >= 0
        ? { id: expected.id, index: message.group_index!, count: expected.steps.length, phase: message.group_phase!, elapsed: message.group_elapsed_s } : undefined;
      if (expected && !group) return; // An unrelated or malformed terminal event cannot release a group lock.
      setState((previous) => ({ commandId: eventId, label: message.label || "位置", phase, message: message.message || "", code: message.code, recommendedDuration: message.recommended_duration_s, group: group ?? (expected ? previous.group : undefined) }));
      locked.current = positionMotionBusy(phase);
      if (expected && !locked.current) { active.current = ""; activeGroup.current = null; groupAction.current = false; setGroupActionBusy(false); }
      if (!locked.current) void poll();
    });
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { generation.current++; abort.abort(); window.clearInterval(timer); if (gripperExpiry !== undefined) window.clearTimeout(gripperExpiry); if (liveExpiry !== undefined) window.clearTimeout(liveExpiry); off(); };
  }, [bridge, connected, profileKey]);

  async function execute(position: CustomPosition | "home" | { kind: "joint"; jointName: string; position: number } | { kind: "joints"; targets: Record<string, number>; duration: number } | { kind: "tcp"; pose: TcpPose; duration?: number; gripperPosition?: number } | { kind: "group"; group: MotionGroup }) {
    const value = context.current;
    if (locked.current || value.info.busy) { recordLog("rejected", "已有运动任务，未重复下发", "warn"); return; }
    const groupInput = typeof position === "object" && "kind" in position && position.kind === "group" ? position.group : undefined;
    if (typeof position === "object" && "kind" in position && position.kind === "group") {
      const why = validateMotionGroup(groupInput);
      if (why) { recordLog("rejected", why, "error"); setState({ ...idle, phase: "failed", message: why }); return; }
    }
    const joint = typeof position === "object" && "kind" in position && position.kind === "joint" ? position : null;
    const multi = typeof position === "object" && "kind" in position && position.kind === "joints" ? position : null;
    const tcp = typeof position === "object" && "kind" in position && position.kind === "tcp" ? position : null;
    const group = groupInput ? { ...groupInput, steps: groupInput.steps.map((step) => ({ ...step, positions: [...step.positions] })) } : null;
    const saved = typeof position === "object" && !("kind" in position) ? position : null;
    const label = group ? group.name : joint ? joint.jointName === GRIPPER_JOINT_NAME ? `夹爪（joint7） → ${(joint.position * 1000).toFixed(2)} mm` : `${joint.jointName} → ${(joint.position * 180 / Math.PI).toFixed(2)}°` : multi ? `关节联合调整 · ${multi.duration} s` : tcp ? "TCP 位姿目标" : saved?.name ?? "HOME";
    const fail = (message: string) => {
      recordLog("rejected", `${label} · ${message}`, "error");
      setState({ ...idle, label, phase: "failed", message });
    };
    const block = !value.connected ? "请先连接 Jetson" : value.localBlock || (!value.info.available ? value.info.message : "") ||
      (tcp && !value.info.tcpPose ? "当前 Bridge 不支持 TCP 位姿规划，请更新 Bridge" : "") ||
      (tcp && tcp.duration !== undefined && (!value.info.duration || value.info.durationMessage) ? value.info.durationMessage || "当前 Bridge 不支持指定位姿运动时长" : "") ||
      (joint && !value.info.jointRotation ? "当前 Bridge 不支持单关节旋转，请更新 Bridge" : "") ||
      (multi && (!value.info.jointTargets || !value.info.duration) ? "当前 Bridge 不支持联合关节及指定时长，请更新 Bridge" : "") ||
      (multi ? value.info.durationMessage : "") ||
      (group && (!value.info.group || !value.info.duration) ? "当前 Bridge 不支持动作组，请更新 Bridge" : "") ||
      (group ? value.info.durationMessage : "") ||
      (!value.armed ? "请先确认工作区安全并解锁点位执行" : "");
    if (block) { fail(block); return; }
    if (group) {
      const why = validateMotionGroup(group);
      if (why) { fail(why); return; }
      for (const step of group.steps) if (step.gripperPosition !== undefined) {
        const g = value.info.gripper;
        if (!g.supported || !g.available || !g.fresh) { fail(g.message); return; }
        if (step.gripperPosition < g.lower || step.gripperPosition > g.upper) { fail(`${step.positionName}：夹爪目标超过标定限位`); return; }
      }
    }
    if (position === "home" && value.info.home.length !== 6) { fail("HOME 尚未从 MoveIt SRDF 同步"); return; }
    if (joint && (!(joint.jointName === GRIPPER_JOINT_NAME || ARM_JOINT_NAMES.some((name) => name === joint.jointName)) || !Number.isFinite(joint.position))) {
      fail("单关节目标无效"); return;
    }
    if (multi && (!Number.isFinite(multi.duration) || multi.duration < 1e-9 || multi.duration > 2147483647 ||
        Object.keys(multi.targets).length === 0 || Object.keys(multi.targets).length > 7 ||
        Object.entries(multi.targets).some(([name, angle]) => !(name === GRIPPER_JOINT_NAME || ARM_JOINT_NAMES.some((joint) => joint === name)) || !Number.isFinite(angle)))) {
      fail("关节目标无效或运动时长不是可表示的正数"); return;
    }
    if (saved && (saved.positions.length !== 6 || !saved.positions.every(Number.isFinite))) {
      fail("点位关节数据无效"); return;
    }
    if (tcp && (!tcp.pose.frame_id.trim() || !tcp.pose.tcp_link.trim() || tcp.pose.position.length !== 3 || !tcp.pose.position.every(Number.isFinite) || tcp.pose.orientation.length !== 4 || !tcp.pose.orientation.every(Number.isFinite) || Math.abs(Math.hypot(...tcp.pose.orientation) - 1) > 1e-6 || (tcp.duration !== undefined && (!Number.isFinite(tcp.duration) || tcp.duration < 1e-9 || tcp.duration > 2147483647)))) { fail("TCP 位姿或运动时长无效"); return; }
    const gripperTarget = tcp?.gripperPosition ?? saved?.gripperPosition ?? (joint?.jointName === GRIPPER_JOINT_NAME ? joint.position : multi?.targets[GRIPPER_JOINT_NAME]);
    if (gripperTarget !== undefined) {
      const g = value.info.gripper;
      if (!g.supported || !g.available || !g.fresh) { fail(g.message); return; }
      if (!Number.isFinite(gripperTarget) || gripperTarget < g.lower || gripperTarget > g.upper) { fail("夹爪目标超过标定限位"); return; }
    }
    const current = generation.current, id = crypto.randomUUID();
    recordLog("request", `${label} · ${JSON.stringify(position)}`, "info", id);
    // Lock synchronously: two click events before React commits cannot send twice.
    locked.current = true; active.current = id;
    groupAction.current = false; setGroupActionBusy(false);
    activeGroup.current = group;
    setState({ commandId: id, label, phase: "validating", message: "正在校验执行条件…", group: group ? { id: group.id, index: 0, count: group.steps.length, phase: "preparing", elapsed: 0 } : undefined });
    try {
      const reply = await bridge.request({
        op: group ? "position_group_start" : "position_move", command_id: id, label, confirmation: "ARMED",
        group_id: group?.id, preparation_duration_s: group?.preparationDuration,
        steps: group?.steps.map((step) => ({ id: step.id, label: step.positionName, positions: [...step.positions], gripper_position: step.gripperPosition, motion_duration_s: step.duration, hold_duration_s: step.hold })),
        tcp_pose: tcp ? { ...tcp.pose, position: [...tcp.pose.position], orientation: [...tcp.pose.orientation] } : undefined,
        gripper_position: tcp?.gripperPosition ?? saved?.gripperPosition,
        home: tcp || group ? undefined : position === "home", positions: saved ? [...saved.positions] : undefined,
        joint_name: joint?.jointName, joint_position: joint?.position,
        joint_targets: multi ? { ...multi.targets } : undefined, motion_duration_s: tcp?.duration ?? multi?.duration,
      }, 5000);
      if (generation.current !== current || active.current !== id) return;
      const ack = group ? "position_group_start_ack" : "position_move_ack";
      if (reply.op === ack && reply.accepted === false) {
        locked.current = false;
        if (group) { active.current = ""; activeGroup.current = null; }
        recordLog("rejected", reply.message || "未通过执行校验", "error", id);
        setState({ commandId: id, label, phase: "failed", message: reply.message || "未通过执行校验" });
        return;
      }
      if (reply.op !== ack && reply.op !== "position_motion") throw new Error("Bridge 未确认运动");
    } catch (e) {
      if (generation.current !== current || active.current !== id) return;
      recordLog("ack", `运动受理未确认：${e instanceof Error ? e.message : String(e)}`, "error", id);
      // An ACK timeout does not prove the robot rejected a goal. Keep the
      // lock and query status until a terminal event or explicit cancel arrives.
      setState((previous) => ({ ...previous, commandId: id, label, phase: "stop_failed", message: `运动受理状态未确认：${e instanceof Error ? e.message : String(e)}；请查询状态或取消` }));
      try { await bridge.request({ op: "position_motion_info" }); } catch { /* watchdog remains on Jetson */ }
    }
  }
  async function cancel() {
    const id = active.current, current = generation.current;
    if (!id || !context.current.connected) return;
    recordLog("cancel", "请求取消，等待服务端停止确认", "warn", id);
    setState((value) => ({ ...value, phase: "canceling", message: "正在请求取消，等待停止确认…" }));
    try { await bridge.request({ op: "position_cancel", command_id: id }, 5000); }
    catch (e) {
      if (generation.current === current && active.current === id) {
        recordLog("cancel", `停止未确认：${e instanceof Error ? e.message : String(e)}`, "error", id);
        setState((value) => ({ ...value, phase: "stop_failed", message: `停止未确认：${e instanceof Error ? e.message : String(e)}` }));
      }
    }
  }
  async function controlGroup(action: "pause" | "resume") {
    const id = active.current, current = generation.current, value = context.current;
    if (!value.connected || !id || !activeGroup.current || !locked.current || groupAction.current) return;
    if (action === "resume") {
      const why = value.localBlock || (!value.info.available ? value.info.message : "") || (!value.armed ? "请先确认工作区安全并解锁点位执行" : "");
      if (why) { recordLog("rejected", why, "warn", id); return; }
    }
    groupAction.current = true; setGroupActionBusy(true);
    const op = `position_group_${action}`;
    try {
      const reply = await bridge.request({ op, command_id: id }, 5000);
      if (generation.current !== current || active.current !== id) return;
      if (reply.op !== `${op}_ack` || reply.accepted !== true) throw new Error(reply.message || "Bridge 未确认动作组操作");
      recordLog(action, action === "pause" ? "已请求在当前段停稳后暂停，以服务端状态为准" : "已请求继续动作组，以服务端状态为准", "info", id);
    } catch (error) {
      if (generation.current !== current || active.current !== id) return;
      const message = `动作组${action === "pause" ? "暂停" : "继续"}未确认：${error instanceof Error ? error.message : String(error)}`;
      recordLog(action, message, "warn", id);
      setState((previous) => ({ ...previous, message }));
    } finally {
      if (generation.current === current && active.current === id) { groupAction.current = false; setGroupActionBusy(false); }
    }
  }
  return {
    logs, recordLog, state, homePositions: info.home, gripper: info.gripper, armed, setArmed,
    busy: positionMotionBusy(state.phase) || info.busy,
    reason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : ""),
    jointRotationReason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : "") ||
      (!info.jointRotation ? "当前 Bridge 不支持单关节旋转，请更新 Bridge" : ""),
    jointTargetsReason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : "") ||
      (!info.jointTargets || !info.duration ? "当前 Bridge 不支持联合关节及指定时长，请更新 Bridge" : "") || info.durationMessage,
    tcpPoseReason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : "") || (!info.tcpPose ? "当前 Bridge 不支持 TCP 位姿规划，请更新 Bridge" : ""),
    groupReason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : "") || (!info.group || !info.duration ? "当前 Bridge 不支持动作组，请更新 Bridge" : "") || info.durationMessage,
    groupActionBusy,
    executeGroup: (group) => execute({ kind: "group", group }),
    pauseGroup: () => controlGroup("pause"), resumeGroup: () => controlGroup("resume"),
    executeTcpPose: (pose, duration, gripperPosition) => execute({ kind: "tcp", pose: { ...pose, position: [...pose.position], orientation: [...pose.orientation] }, duration, gripperPosition }),
    executeJoints: (targets, duration) => execute({ kind: "joints", targets: { ...targets }, duration }),
    execute, executeJoint: (jointName, position) => execute({ kind: "joint", jointName, position }), cancel,
  };
}
