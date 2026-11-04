import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { ConnectionProfile, RemoteActionResult, RosControlStatus } from "./types";
import type { TopicSample } from "./appLogic";
import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME } from "./positionLogic";
import { controllerStatusFresh } from "./controllersInfoLogic";

export function teachingControllersReady(status: RosControlStatus | null | undefined): boolean {
  if (!controllerStatusFresh(status)) return false;
  const active = status!.controllers.filter((c) => c.state === "active");
  return ["gravity_compensation_controller", "gripper_trajectory_controller"].every((name) => active.some((c) => c.name === name)) &&
    !active.some((c) => ["arm_teleop_controller", "arm_trajectory_controller", "vla_position_controller", "joint4_calibration_controller", "gripper_teleop_controller"].includes(c.name));
}

export function useTeachingGripper(profile: ConnectionProfile, connected: boolean) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = useRef<{ id: string; profile: ConnectionProfile; done: Promise<void> } | null>(null);
  const generation = useRef(0);
  const context = JSON.stringify([profile, connected]);
  const latestContext = useRef(context); latestContext.current = context;
  function cancelCommand(command: { id: string; profile: ConnectionProfile }) {
    return invoke<RemoteActionResult>("teaching_gripper_action", { profile: command.profile, operation: "cancel", commandId: command.id, position: null, confirmation: "" });
  }
  useEffect(() => {
    generation.current++; setBusy(false); setMessage("");
    return () => {
      generation.current++;
      const command = current.current;
      current.current = null;
      if (command) void cancelCommand(command).catch(() => {});
    };
  }, [context]);
  async function move(position: number) {
    if (!connected || current.current || !Number.isFinite(position) || position < 0 || position > 0.05) return;
    const ticket = generation.current, startContext = context;
    const id = crypto.randomUUID();
    const valid = () => generation.current === ticket && latestContext.current === startContext;
    setBusy(true); setMessage("夹爪执行中，等待停稳反馈…");
    const done = (async () => {
      try {
        const result = await invoke<RemoteActionResult>("teaching_gripper_action", { profile, operation: "move", commandId: id, position, confirmation: "ARMED" });
        if (valid()) setMessage(result.message);
      } catch (error) {
        if (valid()) setMessage(`夹爪停止状态未确认：${String(error)}`);
      } finally {
        if (current.current?.id === id) current.current = null;
        if (valid()) setBusy(false);
      }
    })();
    current.current = { id, profile, done };
    await done;
  }
  async function cancel() {
    const command = current.current;
    if (!command) return;
    const ticket = generation.current;
    try {
      const result = await cancelCommand(command);
      if (ticket === generation.current && current.current?.id === command.id) setMessage(result.message);
    } catch (error) {
      if (ticket === generation.current) setMessage(`取消未确认：${String(error)}`);
    }
  }
  async function finishBeforeStop() {
    const command = current.current;
    if (!command) return;
    await cancel();
    await command.done;
  }
  return { busy, message, move, cancel, finishBeforeStop };
}


export const TEACHING_FEEDBACK_TOPIC = "/robot_feedback/joint_states";

export function captureTeachingPose(sample: TopicSample | undefined, now: number): { positions: number[]; gripperPosition: number } | { error: string } {
  if (!sample || !Number.isFinite(sample.lastAt) || now < sample.lastAt || now - sample.lastAt >= 500) return { error: "等待新鲜的示教标定反馈" };
  const data = sample.data as { name?: unknown; position?: unknown } | null;
  if (!data || !Array.isArray(data.name) || !Array.isArray(data.position)) return { error: "示教反馈格式无效" };
  const names = data.name, positions = data.position;
  const ordered = [...ARM_JOINT_NAMES, GRIPPER_JOINT_NAME].map(name => positions[names.indexOf(name)]);
  if (new Set(names).size !== names.length || !ordered.every(v => typeof v === "number" && Number.isFinite(v)) || ordered[6] < 0 || ordered[6] > .05) return { error: "示教七轴反馈缺失或夹爪标定值无效" };
  return { positions: ordered.slice(0, 6), gripperPosition: ordered[6] };
}
