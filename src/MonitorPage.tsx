import { useEffect, useMemo, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { DataGraph } from "./DataGraph";
import type { MonitorDashboard, MonitorWorkspace } from "./monitorLogic";
import {
  MONITOR_GRID_COLS,
  MONITOR_PANEL_MIN_H,
  MONITOR_PANEL_MIN_W,
  createEmptyDashboard,
  createTorqueDashboard,
  isSafeBagPath,
  selectedMonitorDashboard,
} from "./monitorLogic";
import type { RosbagPlayStatus } from "./types";

const ReactGridLayout = WidthProvider(GridLayout);

export type MonitorSourceMode = "live" | "bag";

export function MonitorPage({
  workspace,
  jointStateTopic,
  liveUpdates,
  bagStatus,
  bagBusy,
  bagNotice,
  onSelectDashboard,
  onAddDashboard,
  onRenameDashboard,
  onDeleteDashboard,
  onLayoutChange,
  onRemovePanel,
  onClearPanels,
  onRefreshBagStatus,
  onStartBagPlay,
  onStopBagPlay,
}: {
  workspace: MonitorWorkspace;
  jointStateTopic: string;
  liveUpdates: boolean;
  bagStatus: RosbagPlayStatus | null;
  bagBusy: boolean;
  bagNotice: string;
  onSelectDashboard(dashboardId: string): void;
  onAddDashboard(dashboard: MonitorDashboard): void;
  onRenameDashboard(dashboardId: string, name: string): void;
  onDeleteDashboard(dashboardId: string): void;
  onLayoutChange(dashboardId: string, layout: Layout[]): void;
  onRemovePanel(dashboardId: string, panelId: string): void;
  onClearPanels(dashboardId: string): void;
  onRefreshBagStatus(): void;
  onStartBagPlay(bagPath: string): void;
  onStopBagPlay(): void;
}) {
  const dashboard = selectedMonitorDashboard(workspace);
  const [mode, setMode] = useState<MonitorSourceMode>("live");
  const [bagPath, setBagPath] = useState(bagStatus?.bagPath || "robot-console-bags/");
  const [renameValue, setRenameValue] = useState(dashboard?.name ?? "");
  const [pathError, setPathError] = useState("");

  useEffect(() => {
    setRenameValue(dashboard?.name ?? "");
  }, [dashboard?.id, dashboard?.name]);

  useEffect(() => {
    if (bagStatus?.bagPath) setBagPath(bagStatus.bagPath);
  }, [bagStatus?.bagPath]);

  const layout = useMemo(
    () =>
      (dashboard?.panels ?? []).map((panel) => ({
        i: panel.id,
        x: panel.layout.x,
        y: panel.layout.y,
        w: panel.layout.w,
        h: panel.layout.h,
        minW: MONITOR_PANEL_MIN_W,
        minH: MONITOR_PANEL_MIN_H,
      })),
    [dashboard?.panels],
  );

  if (!dashboard) return null;

  const playing = Boolean(bagStatus?.playing);
  const chartsLive = liveUpdates && (mode === "live" || playing);

  const commitRename = () => {
    if (renameValue.trim() && renameValue.trim() !== dashboard.name) {
      onRenameDashboard(dashboard.id, renameValue);
    } else {
      setRenameValue(dashboard.name);
    }
  };

  const startPlay = () => {
    const trimmed = bagPath.trim();
    if (!isSafeBagPath(trimmed)) {
      setPathError("路径仅允许字母数字、/ . _ -，且不能含 .. 或以 - 开头的段");
      return;
    }
    setPathError("");
    onStartBagPlay(trimmed);
  };

  return (
    <main className="monitor-page">
      <header className="monitor-page-header">
        <div>
          <h1>Monitor</h1>
          <span>Dashboard / Panel / Chart · 拖拽缩放 · 实时或 rosbag 回放</span>
        </div>
        <div className="monitor-mode" role="group" aria-label="数据源">
          <button
            type="button"
            className={mode === "live" ? "active" : ""}
            aria-pressed={mode === "live"}
            onClick={() => setMode("live")}
          >
            实时
          </button>
          <button
            type="button"
            className={mode === "bag" ? "active" : ""}
            aria-pressed={mode === "bag"}
            onClick={() => setMode("bag")}
          >
            Bag 回放
          </button>
        </div>
      </header>

      <div className="monitor-panels-bar" role="tablist" aria-label="Monitor 仪表盘">
        {workspace.dashboards.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className={entry.id === dashboard.id ? "active" : ""}
            aria-selected={entry.id === dashboard.id}
            onClick={() => onSelectDashboard(entry.id)}
          >
            {entry.name}
            <small>{entry.panels.length}</small>
          </button>
        ))}
        <button
          type="button"
          className="monitor-panel-add"
          aria-label="新建空仪表盘"
          title="新建空仪表盘"
          onClick={() => onAddDashboard(createEmptyDashboard())}
        >
          +
        </button>
        <button
          type="button"
          className="monitor-panel-add"
          aria-label="添加力矩模板仪表盘"
          title="添加力矩模板仪表盘"
          onClick={() => onAddDashboard(createTorqueDashboard(jointStateTopic))}
        >
          +转矩
        </button>
      </div>

      <div className="monitor-panel-meta">
        <label>
          仪表盘名称
          <input
            value={renameValue}
            aria-label="仪表盘名称"
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <button
          type="button"
          className="ghost"
          aria-label={`删除仪表盘 ${dashboard.name}`}
          onClick={() => onDeleteDashboard(dashboard.id)}
        >
          删除仪表盘
        </button>
        <button
          type="button"
          className="ghost monitor-clear-panels"
          disabled={dashboard.panels.length === 0}
          onClick={() => onClearPanels(dashboard.id)}
        >
          清空面板
        </button>
        <span className="monitor-panel-hint">
          从 Topics → Inspector 右键选择目标仪表盘添加 Panel；拖拽面板标题栏移动、拖角缩放。Motor Torque 默认含 effort[0..6]。
        </span>
      </div>

      {mode === "bag" && (
        <section className="monitor-bag" aria-label="rosbag 回放">
          <div className="monitor-bag-row">
            <label>
              Jetson bag 路径
              <input
                value={bagPath}
                aria-label="Jetson bag 路径"
                placeholder="robot-console-bags/robot-console-…"
                onChange={(event) => {
                  setBagPath(event.target.value);
                  setPathError("");
                }}
              />
            </label>
            <button type="button" className="ghost" disabled={bagBusy} onClick={onRefreshBagStatus}>
              刷新状态
            </button>
            {playing ? (
              <button type="button" className="primary danger" disabled={bagBusy} onClick={onStopBagPlay}>
                {bagBusy ? "处理中…" : "停止回放"}
              </button>
            ) : (
              <button type="button" className="primary" disabled={bagBusy} onClick={startPlay}>
                {bagBusy ? "处理中…" : "开始回放"}
              </button>
            )}
          </div>
          <p className="monitor-bag-note">
            回放在 Jetson 上执行 <code>ros2 bag play</code>，经 Bridge 订阅进入同一套曲线（非本机解析 bag）。
            请确保录制中的 Topic 已在 Monitor 面板配置；本机下载 / 索引 / 客户端解析仍属后续工作。
          </p>
          {(pathError || bagNotice || bagStatus?.message) && (
            <p className={`monitor-bag-status ${pathError ? "error" : ""}`}>
              {pathError || bagNotice || bagStatus?.message}
            </p>
          )}
        </section>
      )}

      <div className="monitor-grid-wrap">
        <div className="monitor-grid-toolbar">
          <span>
            {dashboard.panels.length === 0
              ? "空仪表盘"
              : `${dashboard.panels.length} 个 Panel · 窗口 30s`}
            {chartsLive ? "" : " · 已暂停"}
          </span>
        </div>
        {dashboard.panels.length === 0 ? (
          <div className="monitor-grid-empty" role="status">
            从 Topics → Inspector 加入数值字段，或使用「+转矩」模板
          </div>
        ) : (
          <ReactGridLayout
            className="monitor-grid"
            cols={MONITOR_GRID_COLS}
            rowHeight={80}
            margin={[10, 10]}
            containerPadding={[0, 0]}
            layout={layout}
            draggableHandle=".monitor-panel-drag"
            draggableCancel="button,input,textarea,a"
            onLayoutChange={(next) => onLayoutChange(dashboard.id, next)}
            compactType="vertical"
          >
            {dashboard.panels.map((panel) => (
              <div key={panel.id} className="monitor-panel-tile" data-panel-id={panel.id}>
                <div className="monitor-panel-drag" title="拖拽移动">
                  <span className="monitor-panel-drag-label">{panel.title}</span>
                </div>
                <DataGraph
                  seriesList={[panel.series]}
                  liveUpdates={chartsLive}
                  compact
                  title={panel.title}
                  emptyHint="等待数据"
                  onRemoveSeries={() => onRemovePanel(dashboard.id, panel.id)}
                  onClearSeries={() => onRemovePanel(dashboard.id, panel.id)}
                />
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </main>
  );
}
