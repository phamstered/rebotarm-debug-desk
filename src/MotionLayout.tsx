import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { boundedMotionSize, defaultMotionLayout, loadMotionLayout, MOTION_LAYOUT_KEY, motionSizeLimits, type MotionLayout, type MotionSize } from "./motionLayoutLogic";

const Context = createContext<{ sizes: MotionLayout; active: boolean; compact: boolean; focusMode: boolean; exitFocus?(): void; resetVersion: number; setSize(key: MotionSize, value: number): void } | null>(null);
export function useMotionLayout() { return useContext(Context); }
export function MotionLayoutProvider({ active, visible = active, compact = false, focusMode = false, exitFocus, resetVersion = 0, children }: { active: boolean; visible?: boolean; compact?: boolean; focusMode?: boolean; exitFocus?(): void; resetVersion?: number; children: ReactNode }) {
  const [sizes, setSizes] = useState(loadMotionLayout);
  const previousReset = useRef(resetVersion);
  useEffect(() => {
    if (previousReset.current !== resetVersion) { previousReset.current = resetVersion; setSizes({ ...defaultMotionLayout }); }
  }, [resetVersion]);
  useEffect(() => { try { localStorage.setItem(MOTION_LAYOUT_KEY, JSON.stringify(sizes)); } catch { /* Layout remains usable when storage is unavailable. */ } }, [sizes]);
  const style = Object.fromEntries(Object.entries(sizes).map(([key, value]) => [`--motion-${key}`, `${value}px`])) as CSSProperties;
  return <Context.Provider value={{ sizes, active, compact, focusMode, exitFocus, resetVersion, setSize: (key, value) => setSizes((old) => ({ ...old, [key]: boundedMotionSize(key, value) })) }}>
    <div className="motion-layout-root" hidden={!visible} style={style}>{children}</div>
  </Context.Provider>;
}

/** The dimension is measured from the actual panel, so resizing after a window shrink never jumps. */
export function MotionDivider({ size, label, axis, edge = "start", panel, container, maxFraction = .7, className = "" }: {
  size: MotionSize; label: string; axis: "x" | "y"; edge?: "start" | "end";
  panel: string; container: string; maxFraction?: number; className?: string;
}) {
  const layout = useMotionLayout();
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => { if (!layout?.active) cleanup.current?.(); return () => cleanup.current?.(); }, [layout?.active, layout?.resetVersion]);
  if (!layout) return null;
  const [minimum, maximum] = motionSizeLimits[size];
  const sign = edge === "end" ? -1 : 1;
  function measurements(node: HTMLElement) {
    const host = node.closest(container);
    const target = host?.querySelector(panel);
    const bounds = host?.getBoundingClientRect();
    const current = target?.getBoundingClientRect();
    return { value: (axis === "x" ? current?.width : current?.height) || layout!.sizes[size],
      available: (axis === "x" ? bounds?.width : bounds?.height) ? (axis === "x" ? bounds!.width : bounds!.height) * maxFraction : Infinity };
  }
  return <div role="separator" tabIndex={0} className={`motion-divider motion-divider-${axis} ${className}`}
    aria-label={label} aria-orientation={axis === "x" ? "vertical" : "horizontal"}
    aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={Math.round(layout.sizes[size])}
    title={`${label}；方向键调整，双击恢复默认`}
    onDoubleClick={() => layout.setSize(size, defaultMotionLayout[size])}
    onKeyDown={(event) => {
      if (!layout.active) return;
      const decrease = axis === "x" ? "ArrowLeft" : "ArrowUp";
      const increase = axis === "x" ? "ArrowRight" : "ArrowDown";
      if (![decrease, increase, "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const { value, available } = measurements(event.currentTarget);
      const next = event.key === "Home" ? minimum : event.key === "End" ? maximum : value + (event.key === decrease ? -1 : 1) * sign * (event.shiftKey ? 40 : 10);
      layout.setSize(size, boundedMotionSize(size, next, available));
    }}
    onPointerDown={(event) => {
      if (!layout.active || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); cleanup.current?.();
      const { value, available } = measurements(event.currentTarget);
      const start = axis === "x" ? event.clientX : event.clientY;
      const pointerId = event.pointerId;
      const oldCursor = document.body.style.cursor;
      document.body.classList.add("resizing-panels"); document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      const move = (pointer: PointerEvent) => {
        if (pointer.pointerId !== pointerId) return;
        layout.setSize(size, boundedMotionSize(size, value + ((axis === "x" ? pointer.clientX : pointer.clientY) - start) * sign, available));
      };
      const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); window.removeEventListener("blur", stop); document.body.style.cursor = oldCursor; document.body.classList.remove("resizing-panels"); cleanup.current = null; };
      cleanup.current = stop;
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop); window.addEventListener("blur", stop);
    }} />;
}
