import { useEffect, useState } from "react";
import { DataGraph } from "./DataGraph";
import type { DataSeries } from "./dataGraphLogic";
import { removeSeries } from "./dataGraphLogic";
import type { MonitorPanel, MonitorWorkspace } from "./monitorLogic";
import {
  createEmptyPanel,
  createTorquePanel,
  isSafeBagPath,
  selectedMonitorPanel,
} from "./monitorLogic";
import type { RosbagPlayStatus } from "./types";

export type MonitorSourceMode = "live" | "bag";

export function MonitorPage({
  workspace,
  jointStateTopic,
  liveUpdates,
  bagStatus,
  bagBusy,
  bagNotice,
  onSelectPanel,
  onAddPanel,
  onRenamePanel,
  onDeletePanel,
  onUpdatePanelSeries,
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
  onSelectPanel(panelId: string): void;
  onAddPanel(panel: MonitorPanel): void;
  onRenamePanel(panelId: string, name: string): void;
  onDeletePanel(panelId: string): void;
  onUpdatePanelSeries(panelId: string, series: DataSeries[]): void;
  onRefreshBagStatus(): void;
  onStartBagPlay(bagPath: string): void;
  onStopBagPlay(): void;
}) {
  const panel = selectedMonitorPanel(workspace);
  const [mode, setMode] = useState<MonitorSourceMode>("live");
  const [bagPath, setBagPath] = useState(bagStatus?.bagPath || "robot-console-bags/");
  const [renameValue, setRenameValue] = useState(panel?.name ?? "");
  const [pathError, setPathError] = useState("");

  useEffect(() => {
    setRenameValue(panel?.name ?? "");
  }, [panel?.id, panel?.name]);

  useEffect(() => {
    if (bagStatus?.bagPath) setBagPath(bagStatus.bagPath);
  }, [bagStatus?.bagPath]);

  if (!panel) return null;

  const playing = Boolean(bagStatus?.playing);

  const commitRename = () => {
    if (renameValue.trim() && renameValue.trim() !== panel.name) {
      onRenamePanel(panel.id, renameValue);
    } else {
      setRenameValue(panel.name);
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
          <span>多面板数值曲线 · 实时或 rosbag 回放</span>
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

      <div className="monitor-panels-bar" role="tablist" aria-label="Monitor 面板">
        {workspace.panels.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            className={entry.id === panel.id ? "active" : ""}
            aria-selected={entry.id === panel.id}
            onClick={() => onSelectPanel(entry.id)}
          >
            {entry.name}
            <small>{entry.series.length}</small>
          </button>
        ))}
        <button
          type="button"
          className="monitor-panel-add"
          aria-label="新建空面板"
          title="新建空面板"
          onClick={() => onAddPanel(createEmptyPanel())}
        >
          +
        </button>
        <button
          type="button"
          className="monitor-panel-add"
          aria-label="添加力矩模板面板"
          title="添加力矩模板面板"
          onClick={() => onAddPanel(createTorquePanel(jointStateTopic))}
        >
          +转矩
        </button>
      </div>

      <div className="monitor-panel-meta">
        <label>
          面板名称
          <input
            value={renameValue}
            aria-label="面板名称"
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
          aria-label={`删除面板 ${panel.name}`}
          onClick={() => onDeletePanel(panel.id)}
        >
          删除面板
        </button>
        <span className="monitor-panel-hint">
          从 Dashboard → Topic Inspector「加入 Monitor」添加曲线；默认面板为 JointState effort 转矩模板。
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

      <div className="monitor-chart">
        <DataGraph
          seriesList={panel.series}
          liveUpdates={liveUpdates && (mode === "live" || playing)}
          emptyHint="从 Dashboard Topic Inspector 加入数值字段，或使用「+转矩」模板"
          onRemoveSeries={(id) => onUpdatePanelSeries(panel.id, removeSeries(panel.series, id))}
          onClearSeries={() => onUpdatePanelSeries(panel.id, [])}
        />
      </div>
    </main>
  );
}
