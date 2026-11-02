import type { ReactNode } from "react";
import { MotionDivider, MotionLayoutProvider } from "./MotionLayout";
import { MotionOutputPanel, MotionOutputProvider } from "./MotionOutput";
import type { MotionTab } from "./appNavigationLogic";

export function MotionPage({ active, tab, onTabChange, controllersOpen, onToggleControllers,
  controllers, readiness, robot, positions, groups, log, resetVersion }: {
  resetVersion?: number;
  active: boolean;
  tab: MotionTab;
  onTabChange(tab: MotionTab): void;
  controllersOpen: boolean;
  onToggleControllers(): void;
  controllers: ReactNode;
  readiness: ReactNode;
  robot: ReactNode;
  positions: ReactNode;
  groups?: ReactNode;
  log: ReactNode;
}) {
  return <MotionLayoutProvider active={active} resetVersion={resetVersion}><MotionOutputProvider><main className={`motion-workspace${controllersOpen ? "" : " controllers-collapsed"}`} hidden={!active} aria-label="Motion">
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
            className={tab === "positions" ? "active" : ""} onClick={() => onTabChange("positions")}>姿态库</button>
          <button type="button" role="tab" aria-selected={tab === "groups"} aria-controls="motion-groups"
            className={tab === "groups" ? "active" : ""} onClick={() => onTabChange("groups")}>动作组</button>
        </div>
      </div>
      <div className="motion-readiness" aria-label="运动就绪状态">{readiness}</div>
    </header>
    <aside id="motion-controllers" className="motion-controller-sidebar" hidden={!controllersOpen} aria-label="Motion Controllers">{active ? controllers : null}</aside>
    {controllersOpen && <MotionDivider size="controllersWidth" label="调整 Controllers 宽度" axis="x" panel=".motion-controller-sidebar" container=".motion-workspace" maxFraction={.5} className="motion-controllers-divider" />}
    <section className="motion-content">
      <div id="motion-robot" className="robot-view-pane" hidden={tab !== "robot"}>{robot}</div>
      <div id="motion-positions" className="motion-positions" hidden={tab !== "positions"}>{positions}</div>
      <div id="motion-groups" className="motion-groups" hidden={tab !== "groups"}>{groups}</div>
    </section>
    <MotionDivider size="logHeight" label="调整 Motion 日志高度" axis="y" edge="end" panel=".motion-workspace-log" container=".motion-workspace" maxFraction={.5} className="motion-log-divider" />
    <section className="motion-workspace-log" aria-label="Motion 输出"><MotionOutputPanel log={log} /></section>
  </main></MotionOutputProvider></MotionLayoutProvider>;
}
