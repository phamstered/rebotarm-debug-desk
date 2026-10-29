import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope } from "./types";
import type { CustomPosition } from "./positionLogic";

export type PositionMotionPhase = "idle" | "validating" | "planning" | "executing" | "verifying" | "canceling" | "stopping" | "stop_failed" | "succeeded" | "failed" | "canceled";
export type PositionMotionState = { commandId: string; label: string; phase: PositionMotionPhase; message: string; code?: number };
export const positionMotionBusy = (phase: PositionMotionPhase) => !["idle", "succeeded", "failed", "canceled"].includes(phase);
export type PositionMotionControls = {
  state: PositionMotionState;
  homePositions: number[];
  reason: string;
  busy: boolean;
  armed: boolean;
  setArmed(value: boolean): void;
  execute(position: CustomPosition | "home"): Promise<void>;
  cancel(): Promise<void>;
};
const idle: PositionMotionState = { commandId: "", label: "", phase: "idle", message: "" };
const phases: PositionMotionPhase[] = ["validating", "planning", "executing", "verifying", "canceling", "stopping", "stop_failed", "succeeded", "failed", "canceled"];

export function usePositionMotion(bridge: Pick<BridgeClient, "request" | "onMessage">, connected: boolean, profileKey: string, localBlock: string): PositionMotionControls {
  const [state, setState] = useState<PositionMotionState>(idle);
  const [info, setInfo] = useState({ available: false, message: "等待 MoveIt 状态", home: [] as number[], busy: false });
  const [armed, setArmed] = useState(false);
  const generation = useRef(0);
  const active = useRef("");
  const locked = useRef(false);
  const context = useRef({ connected, profileKey, localBlock, armed, info });
  context.current = { connected, profileKey, localBlock, armed, info };

  useEffect(() => {
    const current = ++generation.current;
    active.current = ""; locked.current = false;
    setArmed(false); setState(idle); setInfo({ available: false, message: "等待 MoveIt 状态", home: [], busy: false });
    if (!connected) return;
    const abort = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const reply = await bridge.request({ op: "position_motion_info" }, 3000, abort.signal);
        if (generation.current !== current || abort.signal.aborted) return;
        if (reply.op !== "position_motion_info") throw new Error("Bridge 不支持 MoveIt 点位执行，请更新 Bridge");
        const home = Array.isArray(reply.home_positions) && reply.home_positions.length === 6 && reply.home_positions.every(Number.isFinite) ? reply.home_positions : [];
        setInfo({ available: reply.available === true, message: reply.message || "", home, busy: reply.busy === true });
        if (active.current && reply.command_id !== active.current && reply.busy === false) {
          setState((value) => {
            if (value.phase !== "stop_failed") return value;
            locked.current = false;
            return { ...value, phase: "failed", message: "服务端确认没有受理该运动，未重复下发" };
          });
        }
      } catch (e) {
        if (generation.current === current && !abort.signal.aborted)
          setInfo((value) => ({ ...value, available: false, message: String(e instanceof Error ? e.message : e) }));
      } finally { polling = false; }
    };
    const off = bridge.onMessage((message) => {
      if (generation.current !== current || message.op !== "position_motion" || message.command_id !== active.current) return;
      const phase = message.motion_phase as PositionMotionPhase;
      if (!phases.includes(phase)) return;
      setState({ commandId: active.current, label: message.label || "位置", phase, message: message.message || "", code: message.code });
      locked.current = positionMotionBusy(phase);
      if (!locked.current) void poll();
    });
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => { generation.current++; abort.abort(); window.clearInterval(timer); off(); };
  }, [bridge, connected, profileKey]);

  async function execute(position: CustomPosition | "home") {
    const value = context.current;
    if (locked.current) return;
    const label = position === "home" ? "HOME" : position.name;
    const block = !value.connected ? "请先连接 Jetson" : value.localBlock || (!value.info.available ? value.info.message : "") || (!value.armed ? "请先确认工作区安全并解锁点位执行" : "");
    if (block) { setState({ ...idle, label, phase: "failed", message: block }); return; }
    if (position === "home" && value.info.home.length !== 6) { setState({ ...idle, label, phase: "failed", message: "HOME 尚未从 MoveIt SRDF 同步" }); return; }
    if (position !== "home" && (position.positions.length !== 6 || !position.positions.every(Number.isFinite))) {
      setState({ ...idle, label, phase: "failed", message: "点位关节数据无效" }); return;
    }
    const current = generation.current, id = crypto.randomUUID();
    // Lock synchronously: two click events before React commits cannot send twice.
    locked.current = true; active.current = id;
    setState({ commandId: id, label, phase: "validating", message: "正在校验执行条件…" });
    try {
      const reply = await bridge.request({
        op: "position_move", command_id: id, label, confirmation: "ARMED",
        home: position === "home", positions: position === "home" ? undefined : [...position.positions],
      }, 5000);
      if (generation.current !== current || active.current !== id) return;
      if (reply.op === "position_move_ack" && reply.accepted === false) {
        locked.current = false;
        setState({ commandId: id, label, phase: "failed", message: reply.message || "未通过执行校验" });
        return;
      }
      if (reply.op !== "position_move_ack" && reply.op !== "position_motion") throw new Error("Bridge 未确认点位运动");
    } catch (e) {
      if (generation.current !== current || active.current !== id) return;
      // An ACK timeout does not prove the robot rejected a goal. Keep the
      // lock and query status until a terminal event or explicit cancel arrives.
      setState({ commandId: id, label, phase: "stop_failed", message: `运动受理状态未确认：${e instanceof Error ? e.message : String(e)}；请查询状态或取消` });
      try { await bridge.request({ op: "position_motion_info" }); } catch { /* watchdog remains on Jetson */ }
    }
  }
  async function cancel() {
    const id = active.current, current = generation.current;
    if (!id || !context.current.connected) return;
    setState((value) => ({ ...value, phase: "canceling", message: "正在请求取消，等待停止确认…" }));
    try { await bridge.request({ op: "position_cancel", command_id: id }, 5000); }
    catch (e) {
      if (generation.current === current && active.current === id)
        setState((value) => ({ ...value, phase: "stop_failed", message: `停止未确认：${e instanceof Error ? e.message : String(e)}` }));
    }
  }
  return {
    state, homePositions: info.home, armed, setArmed,
    busy: positionMotionBusy(state.phase) || info.busy,
    reason: !connected ? "请先连接 Jetson" : localBlock || (!info.available ? info.message : ""),
    execute, cancel,
  };
}
