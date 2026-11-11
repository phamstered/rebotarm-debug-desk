import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { EditorDocumentClient, DocumentConflict, type EditorDocumentSnapshot } from "./editorDocumentLogic";
import { useEditorDocument } from "./useEditorDocument";
import { hydrateMonitorWorkspace, loadMonitorWorkspace, persistMonitorWorkspace, saveMonitorWorkspace, type MonitorWorkspace } from "./monitorLogic";

/** Only metadata is shared. Keep the current window's points by stable series identity. */
export function mergeMonitorConfiguration(current: MonitorWorkspace, next: MonitorWorkspace): MonitorWorkspace {
  return { ...next, dashboards: next.dashboards.map(dashboard => {
    const previous = current.dashboards.find(d => d.id === dashboard.id);
    return { ...dashboard, panels: dashboard.panels.map(panel => {
      const old = previous?.panels.find(p => p.id === panel.id);
      const series = old ? [old.series, ...old.additionalSeries] : [];
      const retain = (entry: typeof panel.series) => ({ ...entry, points: series.find(s => s.id === entry.id && s.topic === entry.topic && s.fieldPath === entry.fieldPath)?.points ?? [] });
      return { ...panel, series: retain(panel.series), additionalSeries: panel.additionalSeries.map(retain) };
    }) };
  }) };
}

export function clearMonitorSamples(workspace: MonitorWorkspace): MonitorWorkspace {
  return { ...workspace, dashboards: workspace.dashboards.map(d => ({ ...d, panels: d.panels.map(p => ({
    ...p, series: { ...p.series, points: [] }, additionalSeries: p.additionalSeries.map(s => ({ ...s, points: [] })),
  })) })) };
}

export function useMonitorWorkspace(jointTopic: string, native: boolean, owner: boolean) {
  const [workspace, setData] = useState(() => loadMonitorWorkspace(jointTopic));
  const seed = useRef(JSON.stringify(persistMonitorWorkspace(workspace)));
  const client = useMemo(() => native && owner ? new EditorDocumentClient("monitor") : null, [native, owner]);
  const revision = useRef(-1), bootstrapping = useRef(false), mounted = useRef(true);
  const [viewRevision, setViewRevision] = useState(-1);
  const [ready, setReady] = useState(!native), [saveError, setSaveError] = useState("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const accept = (snapshot: EditorDocumentSnapshot) => {
    if (snapshot.content === null) {
      if (revision.current >= 0) {
        setReady(false);
        setSaveError("Monitor 配置已被删除，请重新打开页面后检查配置");
        return;
      }
      if (client && !bootstrapping.current) {
        bootstrapping.current = true;
        void client.change(content => content ?? seed.current).catch(reason => {
          // Another window winning the one-time migration supplies the canonical config.
          if (mounted.current && !(reason instanceof DocumentConflict)) setSaveError(`导入原配置失败：${String(reason)}`);
        }).finally(() => { bootstrapping.current = false; });
      }
      return;
    }
    if (snapshot.revision <= revision.current) return;
    const next = hydrateMonitorWorkspace(JSON.parse(snapshot.content), jointTopic);
    revision.current = snapshot.revision;
    setViewRevision(snapshot.revision);
    setData(current => mergeMonitorConfiguration(current, next));
    setReady(true);
    setSaveError("");
  };
  const readError = useEditorDocument(client, accept);
  useEffect(() => { if (!native) saveMonitorWorkspace(workspace); }, [workspace, native]);
  async function change(update: SetStateAction<MonitorWorkspace>) {
    if (!native) { setData(update); return true; }
    if (!client || !ready) { setSaveError("Monitor 配置尚未加载，暂不能编辑"); return false; }
    try {
      await client.change(content => {
        if (content === null) throw new Error("Monitor 配置已被删除，请重新打开页面");
        const current = hydrateMonitorWorkspace(JSON.parse(content), jointTopic);
        const next = typeof update === "function" ? update(current) : update;
        return JSON.stringify(persistMonitorWorkspace(next));
      }, typeof update === "function" ? undefined : viewRevision);
      if (mounted.current) setSaveError("");
      return true;
    } catch (reason) { if (mounted.current) setSaveError(`保存 Monitor 配置失败：${String(reason)}`); return false; }
  }
  return { workspace, setData, change, ready, error: [readError, saveError].filter(Boolean).join("；") };
}
