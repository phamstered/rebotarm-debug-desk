import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { PAGE_TITLES } from "./nativeWorkspaceLogic";
import type { NativeTaskSnapshot } from "./types";
const PHASES = { submitting: "等待受理", running: "执行中", stopping: "等待停止确认", uncertain: "停止未确认" };

export function NativeTaskStatus() {
  const [task, setTask] = useState<NativeTaskSnapshot | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, running = false, pending = false;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const value = await invoke<NativeTaskSnapshot | null>("native_task_snapshot");
          if (!disposed) { setTask(value); setError(""); }
        }
      } catch (reason) { if (!disposed) setError(`原生任务状态查询失败：${String(reason)}`); }
      finally { running = false; }
    };
    void listen("native-tasks-changed", () => void refresh()).then(stop => {
      if (disposed) stop(); else { unlisten = stop; void refresh(); }
    }).catch(reason => { if (!disposed) setError(`原生任务状态监听失败：${String(reason)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  if (!task && !error) return null;
  const page = task?.window.replace(/^page-/, "") as keyof typeof PAGE_TITLES;
  return <div className="global-motion-status" role="status" aria-label="原生共享运动任务">
    {error || `${PAGE_TITLES[page] || task!.window} · ${task!.kind === "controller" ? "Controller 切换" : task!.kind === "gravity" ? "重力辨识" : task!.kind === "motor" ? "Motor 连续发送" : task!.kind === "pick" ? "视觉抓取" : "点位 / 动作组"} · ${task!.kind === "controller" && task!.phase === "uncertain" ? "结果未确认" : PHASES[task!.phase]} · ${task!.message}`}
  </div>;
}
