import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { ConnectionProfile, RemoteActionResult } from "./types";

export const ARM_STEPS = [
  { id: "prepare", label: "连接检查" },
  { id: "safe-stop", label: "安全停止" },
  { id: "cleanup", label: "清理旧进程" },
  { id: "startup", label: "启动控制器" },
  { id: "verify", label: "核验反馈" },
  { id: "ready", label: "完成" },
] as const;
export type ArmStage = typeof ARM_STEPS[number]["id"];
export type ArmProgress = { stage: ArmStage; message: string; failed: boolean };
export type ArmWorkflow = ArmProgress & { mode: string; running: boolean };

export function workflowSteps(mode: string) {
  return mode === "stop" || mode === "disable-stop" ? ARM_STEPS.filter((s) => s.id !== "startup" && s.id !== "verify") : ARM_STEPS;
}

export function useArmModeWorkflow(profile: ConnectionProfile, connected: boolean) {
  const [workflow, setWorkflow] = useState<ArmWorkflow | null>(null);
  const generation = useRef(0);
  const context = JSON.stringify([profile.host, profile.sshPort, profile.username, profile.identityFile, profile.rosDomainId, profile.rosSetupScript, connected]);
  const latest = useRef(context); latest.current = context;
  useEffect(() => { generation.current++; setWorkflow(null); return () => { generation.current++; }; }, [context]);
  async function run(mode: string) {
    if (mode === "realsense") {
      const onProgress = new Channel<ArmProgress>();
      onProgress.onmessage = () => {};
      return invoke<RemoteActionResult>("start_arm_mode", { profile, mode, onProgress });
    }
    const ticket = ++generation.current; const startedContext = context;
    const current = () => ticket === generation.current && latest.current === startedContext;
    const channel = new Channel<ArmProgress>();
    let finished = false;
    setWorkflow({ mode, stage: "prepare", message: "正在连接控制环境", failed: false, running: true });
    channel.onmessage = (event) => {
      if (finished || !current() || !ARM_STEPS.some((step) => step.id === event.stage)) return;
      setWorkflow({ ...event, mode, running: event.stage !== "ready" && !event.failed });
    };
    try {
      const result = await invoke<RemoteActionResult>("start_arm_mode", { profile, mode, onProgress: channel });
      if (current()) setWorkflow((state) => ({ mode, stage: result.ok ? "ready" : state?.stage ?? "prepare", message: result.ok ? result.message : result.detail || result.message, failed: !result.ok, running: false }));
      return result;
    } catch (reason) {
      if (current()) setWorkflow((state) => ({ mode, stage: state?.stage ?? "prepare", message: String(reason), failed: true, running: false }));
      throw reason;
    } finally {
      finished = true;
    }
  }
  return { workflow, run };
}
