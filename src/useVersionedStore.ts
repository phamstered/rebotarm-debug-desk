import { useEffect, useMemo, useRef, useState } from "react";
import { EditorDocumentClient, type EditorDocumentKey } from "./editorDocumentLogic";
import { useEditorDocument } from "./useEditorDocument";

/** Persisted metadata is shared; unfinished form drafts remain in their page. */
export function useVersionedStore<T>(key: EditorDocumentKey, decode: (raw: string | null) => T, enabled: boolean) {
  const client = useMemo(() => enabled ? new EditorDocumentClient(key) : null, [key, enabled]);
  const [state, setState] = useState<{client: EditorDocumentClient | null; revision: number; value: T}>(() => ({client: null, revision: -1, value: decode(null)}));
  const error = useEditorDocument(client, snapshot => {
    const value = decode(snapshot.content);
    setState(old => old.client === client && old.revision === snapshot.revision ? old : {client, revision: snapshot.revision, value});
  });
  const current = useRef(client); current.current = client;
  const mounted = useRef(true);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ready = !!client && state.client === client && state.revision >= 0 && !error;
  async function change(update: (store: T) => string) {
    if (!mounted.current || !ready || !client || current.current !== client) throw new Error("共享配置尚未成功读取，禁止覆盖文件");
    if (busy.current) throw new Error("正在保存，请等待完成");
    busy.current = true; setSaving(true);
    try { await client.change(raw => update(decode(raw))); }
    finally { busy.current = false; if (mounted.current) setSaving(false); }
  }
  return { value: state.client === client ? state.value : decode(null), ready, saving, error, change };
}
