import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { NativeCollectionOperation } from "./types";
export type CollectionOperation = NativeCollectionOperation;
const actions = { launch: "启动采集器", start_episode: "开始 Episode", save_episode: "保存 Episode", discard_episode: "丢弃 Episode", finish: "完成数据集" };
const phases = { preparing: "检查中", verifying: "核验中", uncertain: "结果未确认", recording: "采集中", succeeded: "已确认", failed: "未执行" };
export function useNativeCollectionOperation(enabled: boolean) {
  const [state, setState] = useState<{ ready: boolean; task: CollectionOperation | null; error: string }>({ ready: false, task: null, error: "" });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, reading = false, pending = false, version = 0;
    let stop: (() => void) | undefined;
    const read = async () => {
      pending = true; version++;
      if (reading) return;
      reading = true;
      try {
        while (pending && !disposed) {
          pending = false; const expected = version;
          const task = await invoke<CollectionOperation | null>("native_collection_operation_snapshot");
          if (task !== null && (!task || typeof task.id !== "number" || !(task.action in actions) || !(task.phase in phases) || typeof task.busy !== "boolean")) throw new Error("原生采集任务响应无效");
          if (!disposed && expected === version) setState({ ready: true, task, error: "" });
        }
      } catch (error) { if (!disposed) setState(old => ({ ...old, ready: false, error: String(error) })); }
      finally { reading = false; if (pending && !disposed) void read(); }
    };
    void listen("native-collection-operation-changed", () => void read()).then(unlisten => {
      if (disposed) unlisten(); else { stop = unlisten; void read(); }
    }).catch(error => { if (!disposed) setState(old => ({ ...old, ready: false, error: String(error) })); });
    return () => { disposed = true; stop?.(); };
  }, [enabled]);
  return state;
}
export function NativeCollectionOperationStatus() {
  const { task, error } = useNativeCollectionOperation(true);
  if (error) return <div className="global-motion-status" role="status">采集任务状态不可用：{error}</div>;
  if (!task || task.phase === "succeeded") return null;
  return <div className="global-motion-status" role="status" aria-label="原生采集操作">
    {task.recovery_error ? <>任务恢复异常 · {task.message}</> : <>{task.host} · {actions[task.action]} · {phases[task.phase]} · {task.message}</>}
  </div>;
}
