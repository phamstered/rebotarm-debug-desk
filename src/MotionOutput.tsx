import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MotionGroupResult } from "./MotionGroupResult";
import { useMotionLayout } from "./MotionLayout";
import type { MotionGroup } from "./motionGroupsLogic";
import type { PositionMotionState } from "./positionMotionLogic";

type Report = { state: PositionMotionState; snapshot: MotionGroup | null };
const Context = createContext<{
  report: Report | null;
  publish(owner: symbol, report: Report | null): void;
  release(owner: symbol): void;
  openReport(): void;
  tab: "log" | "report";
  select(tab: "log" | "report"): void;
  collapsed: boolean;
  toggle(): void;
} | null>(null);
const LogVisible = createContext<boolean | null>(null);
export function useMotionLogVisible() { return useContext(LogVisible); }

export function MotionOutputProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ owner: symbol; report: Report | null } | null>(null);
  const [tab, select] = useState<"log" | "report">("log");
  const layout = useMotionLayout();
  const [collapsed, setCollapsed] = useState(() => layout?.compact ? localStorage.getItem("robot-console-motion-output-open") !== "true" : false);
  useEffect(() => { if(layout?.compact) { try { localStorage.setItem("robot-console-motion-output-open",String(!collapsed)); } catch { /* Memory preference remains available. */ } } },[collapsed,layout?.compact]);
  const reset = useMotionLayout()?.resetVersion;
  const previousReset=useRef(reset);
  useEffect(() => { if(previousReset.current!==reset){previousReset.current=reset;setCollapsed(layout?.compact ?? false);} }, [reset]);
  const publish = useCallback((owner: symbol, report: Report | null) => setCurrent({ owner, report }), []);
  const release = useCallback((owner: symbol) => setCurrent(previous => previous?.owner === owner ? null : previous), []);
  const openReport = useCallback(() => { layout?.exitFocus?.(); select("report"); setCollapsed(false); }, [layout?.exitFocus]);
  return <Context.Provider value={{ report: current?.report ?? null, publish, release, openReport, tab, select, collapsed, toggle: () => setCollapsed(value => !value) }}>{children}</Context.Provider>;
}

/** Publish the immutable execution result without coupling the editor to output layout. */
export function useMotionReport(state: PositionMotionState | undefined, snapshot: MotionGroup | null | undefined) {
  const context = useContext(Context);
  const publish = context?.publish, release = context?.release;
  const owner = useRef(Symbol("motion-report"));
  useEffect(() => { publish?.(owner.current, state ? { state, snapshot: snapshot ?? null } : null); }, [publish, state, snapshot]);
  useEffect(() => { const id = owner.current; return () => release?.(id); }, [release]);
  return context?.openReport;
}

export function MotionOutputPanel({ log }: { log: ReactNode }) {
  const context = useContext(Context);
  const id = useId();
  if (!context) return null;
  const { tab, select, collapsed, toggle, report } = context;
  const layout = useMotionLayout();
  const focusMode = layout?.focusMode ?? false;
  const folded = collapsed || focusMode;
  return <section className={`motion-output-panel${folded ? " collapsed" : ""}`} aria-label="Motion 执行输出">
    <header className="motion-output-header">
      <div role="tablist" aria-label="Motion 执行输出" className="center-tab-list"
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "log" : event.key === "End" ? "report" : tab === "log" ? "report" : "log";
          select(next);
          document.getElementById(`${id}-${next}-tab`)?.focus();
        }}>
        {([ ["log", "执行日志"], ["report", "执行报告"] ] as const).map(([value, label]) => <button key={value} id={`${id}-${value}-tab`} type="button" role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} aria-controls={`${id}-${value}`} className={tab === value ? "active" : ""} onClick={() => { if(focusMode)layout?.exitFocus?.(); select(value); if (collapsed) toggle(); }}>{label}</button>)}
      </div>
      <button type="button" className="motion-output-toggle" aria-expanded={!folded} aria-label={folded ? "展开执行面板" : "收起执行面板"} onClick={()=>{if(focusMode){layout?.exitFocus?.();if(collapsed)toggle();}else toggle();}}>{folded ? "▴" : "▾"}</button>
    </header>
    <div id={`${id}-log`} role="tabpanel" aria-labelledby={`${id}-log-tab`} className="motion-output-log" hidden={folded || tab !== "log"}>
      <LogVisible.Provider value={!folded && tab === "log"}>{log}</LogVisible.Provider>
    </div>
    <div id={`${id}-report`} role="tabpanel" aria-labelledby={`${id}-report-tab`} className="motion-output-report" tabIndex={0} hidden={folded || tab !== "report"}>
      {report ? <MotionGroupResult state={report.state} snapshot={report.snapshot} /> : <p className="muted">暂无动作组执行报告。执行后可在此查看结果与诊断。</p>}
    </div>
  </section>;
}
