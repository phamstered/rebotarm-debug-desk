import robotConsoleIcon from "./assets/robot-console-icon.png";

export type AppPage = "dashboard" | "monitor" | "motor" | "calibration";

function DashboardIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
}

function MonitorIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H4z"/><path d="M8 19h8"/><path d="M7 9h2M11 9h2M15 9h2M7 12h10"/></svg>;
}

function CalibrationIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19h12"/><path d="M9 19v-4l3-3 3 3v4"/><circle cx="7" cy="7" r="3"/><path d="m9.2 9.2 3.1 3.1M14.5 5.5l4 4M16.5 3.5l4 4"/></svg>;
}

function MotorIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>;
}

export function AppNav({ page, expanded, onSelect, onToggle }: {
  page: AppPage;
  expanded: boolean;
  onSelect(page: AppPage): void;
  onToggle(): void;
}) {
  return (
    <nav className={`app-nav ${expanded ? "expanded" : "collapsed"}`} aria-label="主工具栏">
      <div className="app-nav-brand"><img src={robotConsoleIcon} alt="" /><span>Navigation</span></div>
      <div className="app-nav-items">
        <button className={page === "dashboard" ? "active" : ""} aria-current={page === "dashboard" ? "page" : undefined} onClick={() => onSelect("dashboard")} title="Topics"><DashboardIcon /><span>Topics</span></button>
        <button className={page === "monitor" ? "active" : ""} aria-current={page === "monitor" ? "page" : undefined} onClick={() => onSelect("monitor")} title="Monitor"><MonitorIcon /><span>Monitor</span></button>
        <button className={page === "motor" ? "active" : ""} aria-current={page === "motor" ? "page" : undefined} onClick={() => onSelect("motor")} title="Motor"><MotorIcon /><span>Motor</span></button>
        <button className={page === "calibration" ? "active" : ""} aria-label="Joint4 Calibration" aria-current={page === "calibration" ? "page" : undefined} onClick={() => onSelect("calibration")} title="Joint4 Calibration"><CalibrationIcon /><span>Calibration</span></button>
      </div>
      {expanded && (
        <button className="app-nav-toggle" onClick={onToggle} aria-label="完全收起主工具栏" title="收起">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg><span>收起</span>
        </button>
      )}
    </nav>
  );
}
