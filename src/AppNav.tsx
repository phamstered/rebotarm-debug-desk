import robotConsoleIcon from "./assets/robot-console-icon.png";
import { isRosGatedPage, rosGatedNavReason } from "./appLogic";
import type { RosGatedPage } from "./appLogic";

export type AppPage = "status" | "dashboard" | "monitor" | "motor" | "calibration";

function StatusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M7 9h3M7 12h6M7 15h4"/><circle cx="17" cy="15" r="2.2"/></svg>;
}

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

const NAV_ITEMS: Array<{ page: AppPage; label: string; title: string; icon: () => JSX.Element }> = [
  { page: "status", label: "Status", title: "Status", icon: StatusIcon },
  { page: "dashboard", label: "Topics", title: "Topics", icon: DashboardIcon },
  { page: "monitor", label: "Monitor", title: "Monitor", icon: MonitorIcon },
  { page: "motor", label: "Motor", title: "Motor", icon: MotorIcon },
  { page: "calibration", label: "Calibration", title: "Joint4 Calibration", icon: CalibrationIcon },
];

export function AppNav({ page, expanded, rosReady = true, onSelect, onToggle }: {
  page: AppPage;
  expanded: boolean;
  /** When false, Monitor / Motor stay disabled until JointState smoke is green. */
  rosReady?: boolean;
  onSelect(page: AppPage): void;
  onToggle(): void;
}) {
  return (
    <nav className={`app-nav ${expanded ? "expanded" : "collapsed"}`} aria-label="主工具栏">
      <div className="app-nav-brand"><img src={robotConsoleIcon} alt="" /><span>Navigation</span></div>
      <div className="app-nav-items">
        {NAV_ITEMS.map((item) => {
          const gated = isRosGatedPage(item.page);
          const reason = gated ? rosGatedNavReason(item.page as RosGatedPage, rosReady) : "";
          const disabled = Boolean(reason);
          const ariaLabel = item.page === "calibration" ? "Joint4 Calibration" : item.label;
          return (
            <button
              key={item.page}
              className={page === item.page ? "active" : ""}
              aria-current={page === item.page ? "page" : undefined}
              aria-label={ariaLabel}
              aria-disabled={disabled || undefined}
              disabled={disabled}
              title={disabled ? reason : item.title}
              onClick={() => {
                if (disabled) return;
                onSelect(item.page);
              }}
            >
              <item.icon />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      {expanded && (
        <button className="app-nav-toggle" onClick={onToggle} aria-label="完全收起主工具栏" title="收起">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg><span>收起</span>
        </button>
      )}
    </nav>
  );
}
