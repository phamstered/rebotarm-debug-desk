import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { EditorDocumentClient, type EditorDocumentKey, type EditorDocumentSnapshot } from "./editorDocumentLogic";

/** Invalidation is small and coalesced; no document is broadcast to all windows. */
export function useEditorDocument(client: EditorDocumentClient | null, onSnapshot: (value: EditorDocumentSnapshot) => void) {
  const callback = useRef(onSnapshot); callback.current = onSnapshot;
  const [error, setError] = useState("");
  useEffect(() => {
    if (!client) return;
    let disposed = false, pending = false, running = false;
    let unlisten: (() => void) | undefined;
    const unsubscribe = client.subscribe(value => { if (!disposed) callback.current(value); });
    const refresh = async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const snapshot = await client.read();
          if (!disposed) { callback.current(snapshot); setError(""); }
        }
      } catch (reason) { if (!disposed) setError(`读取共享配置失败：${String(reason)}`); }
      finally { running = false; }
    };
    void listen<{key:EditorDocumentKey;revision:number}>("editor-document-changed", event => {
      if (!disposed && event.payload.key === client.key) void refresh();
    }).then(stop => {
      if (disposed) stop(); else { unlisten = stop; void refresh(); }
    }).catch(reason => { if (!disposed) setError(`监听共享配置失败：${String(reason)}`); });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { disposed = true; unsubscribe(); unlisten?.(); window.removeEventListener("focus", focus); };
  }, [client]);
  return error;
}
