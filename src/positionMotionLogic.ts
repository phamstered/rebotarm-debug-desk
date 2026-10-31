import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope, MotionLogEntry } from "./types";
import type { CustomPosition } from "./positionLogic";
import { ARM_JOINT_NAMES } from "./positionLogic";

export type PositionMotionPhase = "idle" | "validating" | "planning" | "executing" | "verifying" | "canceling" | "stopping" | "stop_failed" | "succeeded" | "failed" | "canceled";
export type PositionMotionState = { commandId: string; label: string; phase: PositionMotionPhase; message: string; code?: number; recommendedDuration?: number };
export const positionMotionBusy = (phase: PositionMotionPhase) => !["idle", "succeeded", "failed", "canceled"].includes(phase);
export type PositionMotionControls = {
  logs: MotionLogEntry[];
  recordLog(phase: string, message: string, level?: MotionLogEntry["level"], commandId?: string): void;
  state: PositionMotionState;
  homePositions: number[];
  reason: string;
  busy: boolean;
  armed: boolean;
  setArmed(value: boolean): void;
  execute(position: CustomPosition | "home"): Promise<void>;
  jointRotationReason: string;
  executeJoint(jointName: string, position: number): Promise<void>;
  jointTargetsReason: string;
  executeJoints(targets: Record<string, number>, duration: number): Promise<void>;
  cancel(): Promise<void>;
};
const idle: PositionMotionState = { commandId: "", label: "", phase: "idle", message: "" };
const phases: PositionMotionPhase[] = ["validating", "planning", "executing", "verifying", "canceling", "stopping", "stop_failed", "succeeded", "failed", "canceled"];

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
  const initialInfo = { available: false, message: "等待 MoveIt 状态", home: [] as number[], busy: false, jointRotation: false, jointTargets: false, duration: false, durationMessage: "" };
  const [info, setInfo] = useState(initialInfo);
  const [armed, setArmed] = useState(false);
  const generation = useRef(0);
  const active = useRef("");
  const locked = useRef(false);
  const context = useRef({ connected, profileKey, localBlock, armed, info });
  context.current = { connected, profileKey, localBlock, armed, info };

  useEffect(() => {
    const current = ++generation.current;
    active.current = ""; locked.current = false;
    setArmed(false); setState(idle); setInfo(initialInfo); setLogs([]);
    let logSession = "", logCursor = 0;
    if (!connected) return;
    const abort = new AbortController();
    let polling = false, pollError = "";
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
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
        const home = Array.isArray(reply.home_positions) && reply.home_positions.length === 6 && reply.home_positions.every(Number.isFinite) ? reply.home_positions : [];
        setInfo({ available: reply.available === true, message: reply.message || "", home, busy: reply.busy === true,
          jointRotation: reply.joint_rotation_supported === true, jointTargets: reply.joint_targets_supported === true, duration: reply.motion_duration_supported === true, durationMessage: reply.motion_duration_message || "" });
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
          setInfo((value) => ({ ...value, available: false, message }));
        }
      } finally { polling = false; }
    };
    const off = bridge.onMessage((message) => {
      if (generation.current !== current || message.op !== "position_motion" || message.command_id !== active.current) return;
      const phase = message.motion_phase as PositionMotionPhase;
      if (!phases.includes(phase)) return;
      setState({ commandId: active.current, label: message.label || "位置", phase, message: message.message || "", code: message.code, recommendedDuration: message.recommended_duration_s });
      locked.current = positionMotionBusy(phase);
      if (!locked.current) void poll();
    });
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { generation.current++; abort.abort(); window.clearInterval(timer); off(); };
  }, [bridge, connected, profileKey]);

  async function execute(position: CustomPosition | "home" | { kind: "joint"; jointName: string; position: number } | { kind: "joints"; targets: Record<string, number>; duration: number }) {
    const value = context.current;
    if (locked.current || value.info.busy) { recordLog("rejected", "已有运动任务，未重复下发", "warn"); return; }
    const joint = typeof position === "object" && "kind" in position && position.kind === "joint" ? position : null;
    const multi = typeof position === "object" && "kind" in position && position.kind === "joints" ? position : null;
    const saved = typeof position === "object" && !("kind" in position) ? position : null;
    const label = joint ? `${joint.jointName} → ${(joint.position * 180 / Math.PI).toFixed(2)}°` : multi ? `关节联合调整 · ${multi.duration} s` : saved?.name ?? "HOME";
    const fail = (message: string) => {
      recordLog("rejected", `${label} · ${message}`, "error");
      setState({ ...idle, label, phase: "failed", message });
    };
    const block = !value.connected ? "请先连接 Jetson" : value.localBlock || (!value.info.available ? value.info.message : "") ||
      (joint && !value.info.jointRotation ? "当前 Bridge 不支持单关节旋转，请更新 Bridge" : "") ||
      (multi && (!value.info.jointTargets || !value.info.duration) ? "当前 Bridge 不支持联合关节及指定时长，请更新 Bridge" : "") ||
      (multi ? value.info.durationMessage : "") ||
      (!value.armed ? "请先确认工作区安全并解锁点位执行" : "");
    if (block) { fail(block); return; }
    if (position === "home" && value.info.home.length !== 6) { fail("HOME 尚未从 MoveIt SRDF 同步"); return; }
    if (joint && (!ARM_JOINT_NAMES.some((name) => name === joint.jointName) || !Number.isFinite(joint.position))) {
      fail("单关节目标无效"); return;
    }
    if (multi && (!Number.isFinite(multi.duration) || multi.duration < 1e-9 || multi.duration > 2147483647 ||
        Object.keys(multi.targets).length === 0 || Object.keys(multi.targets).length > 6 ||
        Object.entries(multi.targets).some(([name, angle]) => !ARM_JOINT_NAMES.some((joint) => joint === name) || !Number.isFinite(angle)))) {
      fail("关节目标无效或运动时长不是可表示的正数"); return;
    }
    if (saved && (saved.positions.length !== 6 || !saved.positions.every(Number.isFinite))) {
      fail("点位关节数据无效"); return;
    }
    const current = generation.current, id = crypto.randomUUID();
    recordLog("request", `${label} · ${JSON.stringify(position)}`, "info", id);
    // Lock synchronously: two click events before React commits cannot send twice.
    locked.current = true; active.current = id;
    setState({ commandId: id, label, phase: "validating", message: "正在校验执行条件…" });
    try {
      const reply = await bridge.request({
        op: "position_move", command_id: id, label, confirmation: "ARMED",
        home: position === "home", positions: saved ? [...saved.positions] : undefined,
        joint_name: joint?.jointName, joint_position: joint?.position,
        joint_targets: multi ? { ...multi.targets } : undefined, motion_duration_s: multi?.duration,
      }, 5000);
      if (generation.current !== current || active.current !== id) return;
      if (reply.op === "position_move_ack" && reply.accepted === false) {
        locked.current = false;
        recordLog("rejected", reply.message || "未通过执行校验", "error", id);
        setState({ commandId: id, label, phase: "failed", message: reply.message || "未通过执行校验" });
        return;
      }
      if (reply.op !== "position_move_ack" && reply.op !== "position_motion") throw new Error("Bridge 未确认点位运动");
    } catch (e) {
      if (generation.current !== current || active.current !== id) return;
      recordLog("ack", `运动受理未确认：${e instanceof Error ? e.message : String(e)}`, "error", id);
      // An ACK timeout does not prove the robot rejected a goal. Keep the
      // lock and query status until a terminal event or explicit cancel arrives.
      setState({ commandId: id, label, phase: "stop_failed", message: `运动受理状态未确认：${e instanceof Error ? e.message : String(e)}；请查询状态或取消` });
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
  return {
    logs, recordLog, state, homePositions: info.home, armed, setArmed,
    busy: positionMotionBusy(state.phase) || info.busy,
    reason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : ""),
    jointRotationReason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : "") ||
      (!info.jointRotation ? "当前 Bridge 不支持单关节旋转，请更新 Bridge" : ""),
    jointTargetsReason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : "") ||
      (!info.jointTargets || !info.duration ? "当前 Bridge 不支持联合关节及指定时长，请更新 Bridge" : "") || info.durationMessage,
    executeJoints: (targets, duration) => execute({ kind: "joints", targets: { ...targets }, duration }),
    execute, executeJoint: (jointName, position) => execute({ kind: "joint", jointName, position }), cancel,
  };
}
