import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import { nativeDesktop } from "./nativeWorkspaceLogic";

/** Only the issuing JS lifetime can renew its command; observers never renew it. */
export function useHandeyeInvoke(source: string) {
  const calls = useRef(new Map<string, () => void>());
  useEffect(() => () => {
    for (const stop of calls.current.values()) stop();
    calls.current.clear();
  }, [source]);
  return useCallback(async <T,>(command: "handeye_capture" | "handeye_local", args: Record<string, unknown>): Promise<T> => {
    if (!nativeDesktop()) return invoke<T>(command, args);
    const operationId = crypto.randomUUID();
    let stopped = false, touching = false;
    const timer = window.setInterval(() => {
      if (touching || stopped) return;
      touching = true;
      void invoke("native_local_task_touch", {operationId}).catch(() => {
        // Native admission may still be pending; the owner timeout remains authoritative.
      }).finally(() => { touching = false; });
    }, 1000);
    const stop = () => {
      if (stopped) return;
      stopped = true; window.clearInterval(timer);
      void invoke("native_local_task_cancel", {operationId}).catch(() => {});
    };
    calls.current.set(operationId, stop);
    try {
      const result = await invoke<T>(command, {...args, operationId});
      if (stopped) throw new Error("手眼任务已取消，忽略迟到结果");
      return result;
    } finally {
      window.clearInterval(timer);
      calls.current.delete(operationId);
    }
  }, []);
}
