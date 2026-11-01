import type { ReactNode } from "react";
import type { MotionTab } from "./appNavigationLogic";

export function MotionPage({ active, tab, onTabChange, controllersOpen, onToggleControllers,
  controllers, readiness, robot, positions, log }: {
  active: boolean;
  tab: MotionTab;
  onTabChange(tab: MotionTab): void;
  controllersOpen: boolean;
  onToggleControllers(): void;
  controllers: ReactNode;
  readiness: ReactNode;
  robot: ReactNode;
  positions: ReactNode;
  log: ReactNode;
}) {
  return <main className={`motion-workspace${controllersOpen ? "" : " controllers-collapsed"}`} hidden={!active} aria-label="Motion">
    <header className="motion-workspace-header">
      <div className="motion-workspace-navigation">
        <strong>Motion</strong>
        <button type="button" className="toolbar-action" aria-expanded={controllersOpen}
          aria-controls="motion-controllers" onClick={onToggleControllers}>
          {controllersOpen ? "收起 Controllers" : "展开 Controllers"}
        </button>
        <div role="tablist" aria-label="Motion 视图" className="center-tab-list">
          <button type="button" role="tab" aria-selected={tab === "robot"} aria-controls="motion-robot"
            className={tab === "robot" ? "active" : ""} onClick={() => onTabChange("robot")}>Robot View</button>
          <button type="button" role="tab" aria-selected={tab === "positions"} aria-controls="motion-positions"
            className={tab === "positions" ? "active" : ""} onClick={() => onTabChange("positions")}>位置</button>
        </div>
      </div>
      <div className="motion-readiness" aria-label="运动就绪状态">{readiness}</div>
    </header>
    <aside id="motion-controllers" className="motion-controller-sidebar" hidden={!controllersOpen} aria-label="Motion Controllers">{active ? controllers : null}</aside>
    <section className="motion-content">
      <div id="motion-robot" className="robot-view-pane" hidden={tab !== "robot"}>{robot}</div>
      <div id="motion-positions" className="motion-positions" hidden={tab !== "positions"}>{positions}</div>
    </section>
    <section className="motion-workspace-log" aria-label="Motion 日志">{log}</section>
  </main>;
}
