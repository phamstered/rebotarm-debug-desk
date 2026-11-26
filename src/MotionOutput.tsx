import { TerminalLink } from "./TerminalLink";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
  collapsed: boolean;
  toggle(): void;
} | null>(null);
export function MotionOutputProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ owner: symbol; report: Report | null } | null>(null);
  const layout = useMotionLayout();
  const preferenceKey="robot-console-motion-report-open";
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(preferenceKey) !== "true");
  useEffect(() => { try { localStorage.setItem(preferenceKey,String(!collapsed)); } catch { /* Memory preference remains available. */ } },[collapsed,preferenceKey]);
  const reset = useMotionLayout()?.resetVersion;
  const previousReset=useRef(reset);
  useEffect(() => { if(previousReset.current!==reset){previousReset.current=reset;setCollapsed(true);} }, [reset]);
  const publish = useCallback((owner: symbol, report: Report | null) => setCurrent({ owner, report }), []);
  const release = useCallback((owner: symbol) => setCurrent(previous => previous?.owner === owner ? null : previous), []);
  const openReport = useCallback(() => { layout?.exitFocus?.(); setCollapsed(false); }, [layout?.exitFocus]);
  return <Context.Provider value={{ report: current?.report ?? null, publish, release, openReport, collapsed, toggle: () => setCollapsed(value => !value) }}>{children}</Context.Provider>;
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

export function MotionOutputPanel() {
  const context = useContext(Context);
  if (!context) return null;
  const { collapsed, toggle, report } = context;
  const layout = useMotionLayout();
  const focusMode = layout?.focusMode ?? false;
  const folded = collapsed || focusMode;
  return <section className={`motion-output-panel${folded ? " collapsed" : ""}`} aria-label="Motion 执行报告">
    <header className="motion-output-header"><button type="button" aria-expanded={!folded} onClick={()=>{if(focusMode){layout?.exitFocus?.();if(collapsed)toggle();}else toggle();}}>执行报告 {folded ? "▴" : "▾"}</button><TerminalLink source="Motion">查看 Motion 日志</TerminalLink></header>
    {!folded && <div className="motion-output-report" tabIndex={0}>{report ? <MotionGroupResult state={report.state} snapshot={report.snapshot}/> : <p className="muted">暂无动作组执行报告。执行后可在此查看结果与诊断。</p>}</div>}
  </section>;
}
