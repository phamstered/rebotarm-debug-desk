import type { ReactNode } from "react";
import type { ControllerInfo, RosControlStatus } from "./types";
import {
  CONTROLLER_SNAPSHOT_TTL_MS,
  controllerStatusFresh,
  controllerStatusLabel,
} from "./controllersInfoLogic";
import { isTrajectoryController } from "./trajectoryLogic";

export type ControllerListProps = {
  status: RosControlStatus | null;
  onInspect(name: string): void;
  onManage?(name: string): void;
  focusController?: string;
  /** Motion-only composition; the default list has navigation actions only. */
  renderActions?(controller: ControllerInfo): ReactNode;
};
export function ControllerList({
  status,
  onInspect,
  onManage,
  focusController,
  renderActions,
}: ControllerListProps) {
  return (
    <div className="controller-list">
      <div className="controller-manager-name">
        {status?.manager ?? "/controller_manager"}
      </div>
      {status && (
        <div
          className={`controller-query-status${controllerStatusFresh(status) ? " fresh" : " stale"}`}
          role="status"
        >
          <strong>{controllerStatusLabel(status)}</strong>
          {status.hasSnapshot && (
            <span>
              快照年龄 {((status.snapshotAgeMs ?? 0) / 1000).toFixed(1)} s
              {!controllerStatusFresh(status)
                ? " · 上次结果，仅供只读查看"
                : ""}
            </span>
          )}
          {status.snapshotAgeMs !== undefined &&
            status.snapshotAgeMs >= CONTROLLER_SNAPSHOT_TTL_MS && (
              <span>快照已过期</span>
            )}
          {status.queryPending && <span>后台查询中</span>}
          {!controllerStatusFresh(status) && (
            <p>{status.message || "等待新鲜 Controller 状态"}</p>
          )}
          {!!status.retryAfterMs && (
            <span>重试等待 {(status.retryAfterMs / 1000).toFixed(1)} s</span>
          )}
        </div>
      )}
      {status?.controllers.map((controller) => (
        <article
          className={`controller-item${focusController === controller.name ? " focused" : ""}`}
          key={controller.name}
        >
          <div className="controller-identity">
            <strong>{controller.name}</strong>
            <span
              className={`controller-status-badge ${controllerStatusFresh(status) ? controller.state : "unknown"}`}
            >
              {controller.state}
              {!controllerStatusFresh(status) && "（上次）"}
            </span>
            {isTrajectoryController(controller) && (
              <span className="controller-trajectory-badge">轨迹</span>
            )}
          </div>
          <div className="controller-type">{controller.typeName}</div>
          <div className="controller-actions">
            <button
              type="button"
              onClick={() => onInspect(controller.name)}
              aria-label={`查看 ${controller.name} Graph`}
            >
              查看 Graph
            </button>
            {onManage && (
              <button
                type="button"
                onClick={() => onManage(controller.name)}
                aria-label={`管理 ${controller.name}`}
              >
                管理
              </button>
            )}
            {renderActions?.(controller)}
          </div>
        </article>
      ))}
      {(!status || status.controllers.length === 0) && (
        <p className="controller-empty">
          {status
            ? status.available
              ? "暂无 Controller"
              : "无可确认的 Controller"
            : "等待 Controller 状态"}
        </p>
      )}
    </div>
  );
}
