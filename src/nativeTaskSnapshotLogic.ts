import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { NativeTaskSnapshot } from "./types";

export function useNativeTaskSnapshot(enabled = true) {
  const [task, setTask] = useState<NativeTaskSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled) { setTask(null); setError(""); setLoaded(false); return; }
    setLoaded(false);
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
          if (!disposed) { setTask(value); setError(""); setLoaded(true); }
        }
      } catch (reason) { if (!disposed) setError(`原生任务状态查询失败：${String(reason)}`); }
      finally { running = false; }
    };
    void listen("native-tasks-changed", () => void refresh()).then(stop => {
      if (disposed) stop(); else { unlisten = stop; void refresh(); }
    }).catch(reason => { if (!disposed) setError(`原生任务状态监听失败：${String(reason)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, [enabled]);
  return { task: enabled ? task : null, error: enabled ? error : "", loaded: !enabled || loaded };
}
