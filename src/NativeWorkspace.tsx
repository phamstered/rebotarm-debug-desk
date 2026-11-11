import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { AppPage } from "./appNavigationLogic";
import { PAGE_TITLES, type NativePageState, type NativeWorkspaceSnapshot } from "./nativeWorkspaceLogic";

export function NativeWorkspaceHost({ page, snapshot, covered, onError }: {
  page: AppPage; snapshot: NativeWorkspaceSnapshot; covered: boolean; onError(error: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let running = false;
    let pending = false;
    const update = async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const bounds = element.getBoundingClientRect();
          if (bounds.width > 0 && bounds.height > 0) await invoke("workspace_bounds", { bounds: {
            x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
          }, viewport: { width: window.innerWidth, height: window.innerHeight } });
        }
      } catch (reason) { if (!disposed) error.current(String(reason)); }
      finally { running = false; }
    };
    const observer = new ResizeObserver(() => void update());
    observer.observe(element);
    window.addEventListener("resize", update);
    void update();
    return () => { disposed = true; observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => {
    let disposed = false;
    void invoke("workspace_cover", { covered })
      .catch(reason => { if (!disposed) error.current(String(reason)); });
    return () => { disposed = true; };
  }, [covered]);
  useEffect(() => {
    let disposed = false;
    void invoke("workspace_select", { page }).catch(reason => { if (!disposed) error.current(String(reason)); });
    return () => { disposed = true; };
  }, [page]);
  useEffect(() => () => { void invoke("workspace_cover", { covered: true }).catch(() => {}); }, []);
  const detached = snapshot.pages[page]?.detached;
  return <div className="native-workspace-host" ref={host} aria-label={`${PAGE_TITLES[page]} 页面区域`}>
    {detached && <div className="native-workspace-placeholder">
      <h2>{PAGE_TITLES[page]} 已在独立窗口打开</h2>
      <p>页面内容保留在原窗口中。</p>
      <div><button onClick={() => void invoke("workspace_select", { page }).catch(reason => error.current(String(reason)))}>前往窗口</button>
        <button onClick={() => void invoke("workspace_dock", { page }).catch(reason => error.current(String(reason)))}>收回主窗口</button></div>
    </div>}
  </div>;
}

export function NativePageToolbar({ page, state, connected, busyReason, onAction }: {
  page: AppPage; state?: NativePageState; connected: boolean; busyReason: string;
  onAction(command: "workspace_detach" | "workspace_dock", page: AppPage): void;
}) {
  const blocked = busyReason || state?.busy_reason || (!state?.ready ? "页面加载中" : "");
  return <header className="native-page-toolbar" aria-label="页面窗口工具栏">
    <strong>{PAGE_TITLES[page]}</strong>
    <span className={connected ? "native-page-connected" : "native-page-offline"}>{connected ? "共享连接已就绪" : "未连接 · 在主窗口连接机器人"}</span>
    <button type="button" disabled={Boolean(blocked)} title={blocked || (state?.detached ? "保留当前内容，收回主窗口" : "保留当前内容，移到独立窗口")}
      onClick={() => onAction(state?.detached ? "workspace_dock" : "workspace_detach", page)}>{state?.detached ? "收回主窗口" : "拆出窗口 ↗"}</button>
    {blocked && state?.ready && <span role="status">{blocked}</span>}
  </header>;
}
