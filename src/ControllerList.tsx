import type { ReactNode } from "react";
import type { ControllerInfo, RosControlStatus } from "./types";
import { isTrajectoryController } from "./trajectoryLogic";

export type ControllerListProps = {
  status: RosControlStatus | null;
  onInspect(name: string): void;
  onManage?(name: string): void;
  focusController?: string;
  /** Motion-only composition; the default list has navigation actions only. */
  renderActions?(controller: ControllerInfo): ReactNode;
};
export function ControllerList({ status, onInspect, onManage, focusController, renderActions }: ControllerListProps) {
  return <div className="controller-list">
    <div className="controller-manager-name">{status?.manager ?? "/controller_manager"}</div>
    {status && !status.available && <p className="controller-empty error" role="status">{status.message || "Controller Manager 不可用"}</p>}
    {status?.controllers.map((controller) => <article className={`controller-item${focusController === controller.name ? " focused" : ""}`} key={controller.name}>
      <div className="controller-identity"><strong>{controller.name}</strong><span className={`controller-status-badge ${controller.state}`}>{controller.state}</span>
        {isTrajectoryController(controller) && <span className="controller-trajectory-badge">轨迹</span>}</div>
      <div className="controller-type">{controller.typeName}</div>
      <div className="controller-actions"><button type="button" onClick={() => onInspect(controller.name)} aria-label={`查看 ${controller.name} Graph`}>查看 Graph</button>
        {onManage && <button type="button" onClick={() => onManage(controller.name)} aria-label={`管理 ${controller.name}`}>管理</button>}
        {renderActions?.(controller)}</div>
    </article>)}
    {(!status || status.controllers.length === 0) && <p className="controller-empty">{status ? status.available ? "暂无 Controller" : "无可确认的 Controller" : "等待 Controller 状态"}</p>}
  </div>;
}
