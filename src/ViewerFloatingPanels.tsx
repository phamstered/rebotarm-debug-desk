import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useMotionLayout } from "./MotionLayout";
import { boundViewerPanel, defaultViewerPanel, FLOATING_HEADER_HEIGHT, loadViewerFloating, panelIds, VIEWER_FLOATING_KEY,
  type FloatingPanelState, type ViewerBounds, type ViewerPanelId } from "./viewerFloatingLogic";

const titles = { status: "运动控制", rgbd: "时钟同步 / RGBD", controls: "TCP / 关节操作" };
const labels = { status: "运动状态面板", rgbd: "RGBD 面板", controls: "Robot View 操作面板" };

export function ViewerFloatingPanels({ error, leading, children, rgbd }: {
  error: string; leading?: ReactNode; children: ReactNode; rgbd?: ReactNode;
}) {
  const layout = useMotionLayout();
  const [saved, setSaved] = useState(loadViewerFloating);
  const [bounds, setBounds] = useState<ViewerBounds>({ width: 1000, height: 600 });
  const [order, setOrder] = useState<ViewerPanelId[]>([...panelIds]);
  const host = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const previousReset = useRef(layout?.resetVersion);
  const active = layout?.active ?? true;
  const visibleIds = panelIds.filter(id => id !== "rgbd" || Boolean(rgbd));
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0 && height > 0) setBounds({ width, height });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    if (previousReset.current !== layout?.resetVersion) {
      previousReset.current = layout?.resetVersion; setSaved({}); cleanup.current?.();
    }
  }, [layout?.resetVersion]);
  useEffect(() => { try { localStorage.setItem(VIEWER_FLOATING_KEY, JSON.stringify(saved)); } catch { /* Use in-memory layout. */ } }, [saved]);
  useEffect(() => { if (!active) cleanup.current?.(); return () => cleanup.current?.(); }, [active, bounds.width, bounds.height]);
  const panel = (id: ViewerPanelId) => boundViewerPanel(saved[id] ?? defaultViewerPanel(id, bounds), bounds);
  const raise = (id: ViewerPanelId) => setOrder(old => [...old.filter(item => item !== id), id]);
  function change(id: ViewerPanelId, patch: Partial<FloatingPanelState>) {
    setSaved(old => ({ ...old, [id]: boundViewerPanel({ ...boundViewerPanel(old[id] ?? defaultViewerPanel(id, bounds), bounds), ...patch }, bounds) }));
  }
  function start(event: ReactPointerEvent<HTMLButtonElement>, id: ViewerPanelId, resize: boolean) {
    if (!active || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); cleanup.current?.(); raise(id);
    const initial = panel(id), x = event.clientX, y = event.clientY, pointerId = event.pointerId;
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return;
      const dx = pointer.clientX - x, dy = pointer.clientY - y;
      change(id, resize ? { width: initial.width + dx, height: initial.height + dy } : { x: initial.x + dx, y: initial.y + dy });
    };
    const stop = (pointer?: PointerEvent | Event) => {
      if (pointer && "pointerId" in pointer && pointer.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop); window.removeEventListener("blur", stop);
      cleanup.current = null;
    };
    cleanup.current = stop;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop); window.addEventListener("blur", stop);
  }
  return <div className="viewer-heads-up viewer-floating-layer">
    <div className="viewer-floating-toolbar" role="toolbar" aria-label="Robot View 浮窗">
      {visibleIds.map(id => <button key={id} type="button" aria-pressed={!panel(id).collapsed} onClick={() => {
        cleanup.current?.(); change(id, { collapsed: !panel(id).collapsed }); raise(id);
      }}>{titles[id]}</button>)}
      <button type="button" onClick={() => { cleanup.current?.(); setSaved({}); }}>重置浮窗</button>
    </div>
    <div ref={host} className="viewer-floating-area">
      {visibleIds.map(id => {
        const state = panel(id);
        return <section key={id} className={`viewer-floating-window viewer-floating-${id}${state.collapsed ? " collapsed" : ""}`}
          aria-label={labels[id]} style={{ left: state.x, top: state.y, width: state.width,
            height: state.collapsed ? Math.min(FLOATING_HEADER_HEIGHT, bounds.height) : state.height, zIndex: order.indexOf(id) + 1 }}
          onPointerDown={event => { event.stopPropagation(); raise(id); }} onFocusCapture={() => raise(id)}
          onWheel={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
          <header className="viewer-floating-header">
            <button type="button" className="viewer-floating-drag" aria-label={`移动${titles[id]}浮窗`}
              title="拖动标题移动；方向键微调，Shift 加速" onPointerDown={event => start(event, id, false)}
              onKeyDown={event => {
                if (!active || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault(); const step = event.shiftKey ? 40 : 10;
                change(id, { x: state.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
                  y: state.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) });
              }}>{titles[id]}{id === "status" && error ? " · 异常" : ""}</button>
            <button type="button" aria-label={`${state.collapsed ? "展开" : "折叠"}${titles[id]}浮窗`} aria-expanded={!state.collapsed}
              onClick={() => { cleanup.current?.(); change(id, { collapsed: !state.collapsed }); }}>{state.collapsed ? "＋" : "−"}</button>
          </header>
          <div className="viewer-floating-body" hidden={state.collapsed}>
            {id === "status" ? <>{leading}{error && <div className="viewer-error" role="alert">{error}</div>}</>
              : id === "rgbd" ? rgbd : <div className="viewer-overlay" aria-live="polite">{children}</div>}
          </div>
          {!state.collapsed && <button type="button" className="viewer-floating-resize" aria-label={`调整${titles[id]}浮窗大小`}
            title="拖动调整大小；方向键微调" onPointerDown={event => start(event, id, true)}
            onKeyDown={event => {
              if (!active || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault(); const step = event.shiftKey ? 40 : 10;
              change(id, { width: state.width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
                height: state.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) });
            }}>◢</button>}
        </section>;
      })}
    </div>
  </div>;
}
