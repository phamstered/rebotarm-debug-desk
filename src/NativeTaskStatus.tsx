import { ActionButton } from "./ActionButton";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { PAGE_TITLES } from "./nativeWorkspaceLogic";
import { useNativeTaskSnapshot } from "./nativeTaskSnapshotLogic";
const PHASES = { submitting: "等待受理", running: "执行中", stopping: "等待停止确认", uncertain: "停止未确认" };

export function NativeTaskStatus() {
  const { task, error } = useNativeTaskSnapshot();
  const [canceling, setCanceling] = useState("");
  const [cancelError, setCancelError] = useState({ key: "", message: "" });
  const pendingCancel = useRef("");
  const currentKey = useRef("");
  const taskKey = task ? `${task.id}:${task.command_id}` : "";
  currentKey.current = taskKey;
  async function cancelTrajectory() {
    if (!task || task.kind !== "trajectory" || error || pendingCancel.current === taskKey) return;
    const key = taskKey;
    pendingCancel.current = key; setCanceling(key); setCancelError({ key, message: "" });
    try {
      await invoke("native_trajectory_cancel", { id: task.id, commandId: task.command_id });
      // A successful IPC records intent only; retain the task until a terminal
      // snapshot arrives, including across window loss and reconnection.
    } catch (reason) {
      if (currentKey.current === key) {
        setCancelError({ key, message: `取消请求失败：${String(reason)}` });
        setCanceling("");
      }
      if (pendingCancel.current === key) pendingCancel.current = "";
    }
  }
  if (!task && !error) return null;
  const page = task?.window.replace(/^page-/, "") as keyof typeof PAGE_TITLES;
  const longMessage = Boolean(task && task.message.length > 140);
  const message = longMessage ? "详情已保留，展开查看" : task?.message;
  return <div className="global-motion-status" role="status" aria-label="原生共享运动任务">
    {error || (task?.recovery_error ? `任务恢复异常 · ${message}` : `${PAGE_TITLES[page] || task!.window} · ${task!.kind === "joint4" ? "Joint4 标定" : task!.kind === "trajectory" ? "直接 JTC 轨迹" : task!.kind === "arm_mode" ? "控制环境切换" : task!.kind === "controller" ? "Controller 切换" : task!.kind === "gravity" ? "重力辨识" : task!.kind === "motor" ? "Motor 连续发送" : task!.kind === "pick" ? "视觉抓取" : "点位 / 动作组"} · ${["controller", "arm_mode", "joint4"].includes(task!.kind) && task!.phase === "uncertain" ? "结果未确认" : PHASES[task!.phase]} · ${message}`)}
    {!error && longMessage && <details className="native-task-details" key={taskKey}><summary>查看任务详情</summary><pre>{task!.message}</pre></details>}
    {!error && task?.kind === "trajectory" && <ActionButton type="button"
      disabled={canceling === taskKey || task.phase === "stopping" || task.phase === "uncertain"}
      onClick={() => void cancelTrajectory()}>取消直接轨迹</ActionButton>}
    {cancelError.key === taskKey && cancelError.message && <span role="alert">{cancelError.message}</span>}
  </div>;
}
