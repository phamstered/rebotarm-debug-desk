import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { MonitorChart } from "./MonitorChart";
import type { MonitorChartConfig, MonitorCompactType, MonitorDashboard, MonitorLayoutPreset, MonitorWorkspace } from "./monitorLogic";
import {
  MONITOR_GRID_COLS,
  MONITOR_PANEL_MIN_H,
  MONITOR_PANEL_MIN_W,
  applyLayoutPresetToDashboard,
  createEmptyDashboard,
  createLayoutPresetFromDashboard,
  createTorqueDashboard,
  deleteLayoutPreset,
  exportLayoutPresetsJson,
  importLayoutPresetsJson,
  isSafeBagPath,
  loadLayoutPresets,
  saveLayoutPresets,
  selectedMonitorDashboard,
  upsertLayoutPreset,
} from "./monitorLogic";
import {
  BAG_SEEK_CAVEAT_ZH,
  buildBagPlaybarView,
  resolveMonitorViewNowMs,
} from "./monitorTimeline";
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
  bagClockMs = null,
  bagOriginMs = null,
  bagWallStartedAtMs = null,
  onSelectDashboard,
  onAddDashboard,
  onRenameDashboard,
  onDeleteDashboard,
  onLayoutChange,
  onRemovePanel,
  onUpdatePanelChart,
  onClearPanels,
  onResetLayout,
  onApplyWorkspace,
  onToggleLiveUpdates,
  onSetLayoutLocked,
  onSetCompactType,
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
  /** Latest bag-domain clock (ms) while playing; null when live/unknown. */
  bagClockMs?: number | null;
  bagOriginMs?: number | null;
  bagWallStartedAtMs?: number | null;
  onSelectDashboard(dashboardId: string): void;
  onAddDashboard(dashboard: MonitorDashboard): void;
  onRenameDashboard(dashboardId: string, name: string): void;
  onDeleteDashboard(dashboardId: string): void;
  onLayoutChange(dashboardId: string, layout: Layout[]): void;
  onRemovePanel(dashboardId: string, panelId: string): void;
  onUpdatePanelChart(dashboardId: string, panelId: string, chart: Partial<MonitorChartConfig>): void;
  onClearPanels(dashboardId: string): void;
  onResetLayout(dashboardId: string): void;
  /** Replace workspace after applying a layout preset (panels + lock/compact). */
  onApplyWorkspace(workspace: MonitorWorkspace): void;
  onToggleLiveUpdates(): void;
  onSetLayoutLocked(locked: boolean): void;
  onSetCompactType(compactType: MonitorCompactType): void;
  onRefreshBagStatus(): void;
  onStartBagPlay(bagPath: string): void;
  onStopBagPlay(): void;
}) {
  const dashboard = selectedMonitorDashboard(workspace);
  const [mode, setMode] = useState<MonitorSourceMode>("live");
  const [bagPath, setBagPath] = useState(bagStatus?.bagPath || "robot-console-bags/");
  const [renameValue, setRenameValue] = useState(dashboard?.name ?? "");
  const [pathError, setPathError] = useState("");
  const [crosshairT, setCrosshairT] = useState<number | null>(null);
  const [frozenNow, setFrozenNow] = useState<number | null>(null);
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [layoutPresets, setLayoutPresets] = useState<MonitorLayoutPreset[]>(() => loadLayoutPresets());
  const [presetName, setPresetName] = useState("");
  const [presetNotice, setPresetNotice] = useState("");
  const [wallTick, setWallTick] = useState(() => performance.now());
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRenameValue(dashboard?.name ?? "");
  }, [dashboard?.id, dashboard?.name]);

  useEffect(() => {
    if (bagStatus?.bagPath) setBagPath(bagStatus.bagPath);
  }, [bagStatus?.bagPath]);

  useEffect(() => {
    setMaximizedPanelId(null);
    setCrosshairT(null);
  }, [dashboard?.id]);

  useEffect(() => {
    if (!liveUpdates) {
      setFrozenNow((prev) => {
        if (prev != null) return prev;
        if (mode === "bag" && bagClockMs != null) return bagClockMs;
        return performance.now();
      });
    } else {
      setFrozenNow(null);
    }
  }, [liveUpdates, mode, bagClockMs]);

  useEffect(() => {
    saveLayoutPresets(layoutPresets);
  }, [layoutPresets]);

  const playing = Boolean(bagStatus?.playing);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setWallTick(performance.now()), 250);
    return () => window.clearInterval(id);
  }, [playing]);

  const onCrosshairChange = useCallback((t: number | null) => {
    setCrosshairT(t);
  }, []);

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
        static: workspace.layoutLocked,
      })),
    [dashboard?.panels, workspace.layoutLocked],
  );

  const playbar = useMemo(
    () =>
      buildBagPlaybarView({
        playing,
        wallStartedAtMs: bagWallStartedAtMs,
        bagOriginMs,
        bagClockMs,
        wallNowMs: wallTick,
      }),
    [playing, bagWallStartedAtMs, bagOriginMs, bagClockMs, wallTick],
  );

  const viewNow = resolveMonitorViewNowMs({
    bagPlaying: mode === "bag" && playing,
    bagClockMs,
    wallNowMs: wallTick,
    frozenNowMs: frozenNow,
  });

  if (!dashboard) return null;

  const chartsLive = liveUpdates && (mode === "live" || playing);
  const layoutLocked = workspace.layoutLocked;
  const compactType = workspace.compactType;
  const maximizedPanel = maximizedPanelId
    ? dashboard.panels.find((panel) => panel.id === maximizedPanelId)
    : undefined;
  const timelineHint =
    mode === "bag" && playing
      ? bagClockMs != null
        ? " · 时间轴：bag `/clock` / stamp"
        : " · 时间轴：墙钟（等待 `/clock`）"
      : "";

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

  const toggleMaximize = (panelId: string) => {
    setMaximizedPanelId((current) => (current === panelId ? null : panelId));
  };

  const savePreset = () => {
    const preset = createLayoutPresetFromDashboard(dashboard, presetName || dashboard.name, {
      layoutLocked: workspace.layoutLocked,
      compactType: workspace.compactType,
    });
    if (!preset) {
      setPresetNotice("请输入布局名称");
      return;
    }
    setLayoutPresets((current) => upsertLayoutPreset(current, preset));
    setPresetName("");
    setPresetNotice(`已保存布局「${preset.name}」`);
  };

  const loadPreset = (presetId: string) => {
    const preset = layoutPresets.find((entry) => entry.id === presetId);
    if (!preset) return;
    onApplyWorkspace(applyLayoutPresetToDashboard(workspace, dashboard.id, preset));
    setPresetNotice(`已加载布局「${preset.name}」`);
  };

  const removePreset = (presetId: string) => {
    const preset = layoutPresets.find((entry) => entry.id === presetId);
    setLayoutPresets((current) => deleteLayoutPreset(current, presetId));
    if (preset) setPresetNotice(`已删除布局「${preset.name}」`);
  };

  const exportPresets = () => {
    const blob = new Blob([exportLayoutPresetsJson(layoutPresets)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "monitor-layout-presets.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setPresetNotice("已导出布局预设 JSON");
  };

  const onImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      const result = importLayoutPresetsJson(text, layoutPresets);
      if (result.error) {
        setPresetNotice(`导入失败：${result.error}`);
        return;
      }
      setLayoutPresets(result.presets);
      setPresetNotice(`已导入 ${result.imported} 个布局预设`);
    } catch (reason) {
      setPresetNotice(`导入失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  const renderPanelChart = (panel: (typeof dashboard.panels)[number]) => <MonitorChart
    panel={panel} liveUpdates={chartsLive} crosshairT={crosshairT}
    onCrosshairChange={onCrosshairChange} viewNow={viewNow}
    onChartChange={(chart) => onUpdatePanelChart(dashboard.id, panel.id, chart)}
  />;

  const renderChartControls = (panel: (typeof dashboard.panels)[number]) => <div className="monitor-chart-controls" onDoubleClick={(event) => event.stopPropagation()}>
    <select aria-label={`${panel.title} 图表类型`} value={panel.chart.type} onChange={(event) => onUpdatePanelChart(dashboard.id, panel.id, { type: event.target.value as MonitorChartConfig["type"] })}>
      <option value="time-series">时序图</option><option value="bar">柱状图</option><option value="pie">环形图</option><option value="gauge">Gauge</option>
    </select>
    {panel.chart.type === "time-series" && <select aria-label={`${panel.title} 时序样式`} value={panel.chart.timeStyle} onChange={(event) => onUpdatePanelChart(dashboard.id, panel.id, { timeStyle: event.target.value as MonitorChartConfig["timeStyle"] })}>
      <option value="line">折线</option><option value="points">点</option><option value="bars">柱</option>
    </select>}
    {panel.chart.type === "bar" && <select aria-label={`${panel.title} 条形方向`} value={panel.chart.barOrientation} onChange={(event) => onUpdatePanelChart(dashboard.id, panel.id, { barOrientation: event.target.value as MonitorChartConfig["barOrientation"] })}>
      <option value="vertical">竖向</option><option value="horizontal">横向</option>
    </select>}
  </div>;

  return (
    <main className="monitor-page">
      <header className="monitor-page-header">
        <div>
          <h1>Monitor</h1>
          <span>Dashboard / Panel / Chart · 布局预设 · 共享准星 · Bag `/clock` 时间轴</span>
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
          悬停任一 Chart 显示共享准星；双击 Panel 标题栏最大化。从 Topics → Inspector 添加 Panel。
        </span>
      </div>

      <section className="monitor-layout-presets" aria-label="布局预设">
        <div className="monitor-layout-presets-row">
          <label>
            布局预设名称
            <input
              value={presetName}
              aria-label="布局预设名称"
              placeholder={dashboard.name}
              onChange={(event) => setPresetName(event.target.value)}
            />
          </label>
          <button type="button" className="ghost" onClick={savePreset}>
            保存布局
          </button>
          <button
            type="button"
            className="ghost"
            disabled={layoutPresets.length === 0}
            onClick={exportPresets}
          >
            导出 JSON
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => importInputRef.current?.click()}
          >
            导入 JSON
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="导入布局预设 JSON"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              void onImportFile(file);
              event.target.value = "";
            }}
          />
        </div>
        {layoutPresets.length > 0 && (
          <ul className="monitor-layout-preset-list">
            {layoutPresets.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  className="monitor-layout-preset-load"
                  title={`加载布局 ${preset.name}`}
                  onClick={() => loadPreset(preset.id)}
                >
                  {preset.name}
                  <small>{preset.panels.length} Panel</small>
                </button>
                <button
                  type="button"
                  className="ghost monitor-layout-preset-delete"
                  aria-label={`删除布局 ${preset.name}`}
                  onClick={() => removePreset(preset.id)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
        {presetNotice && <p className="monitor-layout-preset-notice">{presetNotice}</p>}
      </section>

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

          <div className="monitor-playbar" role="group" aria-label="回放控制条">
            <button
              type="button"
              className="monitor-playbar-btn"
              disabled={bagBusy || playing}
              title="以 1x 在 Jetson 上执行 ros2 bag play --clock"
              onClick={startPlay}
            >
              播放 1x
            </button>
            <button
              type="button"
              className="monitor-playbar-btn"
              disabled={bagBusy || !playing}
              title="暂停即停止回放（远端无保位 pause / seek）"
              onClick={onStopBagPlay}
            >
              暂停
            </button>
            <span className="monitor-playbar-rate" title="当前仅支持 1x">
              {playbar.rateLabel}
            </span>
            <div className="monitor-playbar-track" aria-hidden="true">
              <div
                className={`monitor-playbar-fill ${playing ? "indeterminate" : ""}`}
                style={
                  playbar.progressRatio == null
                    ? undefined
                    : { width: `${Math.round(playbar.progressRatio * 100)}%` }
                }
              />
            </div>
            <span className="monitor-playbar-time" aria-label="已播放时长">
              {playbar.elapsedLabel}
            </span>
            <span className="monitor-playbar-status">{playbar.statusLabel}</span>
          </div>
          <p className="monitor-bag-note">
            回放在 Jetson 上执行 <code>ros2 bag play --clock</code>，经 Bridge 订阅进入同一套曲线（非本机解析 bag）。
            图表与准星在收到消息 stamp 或 <code>/clock</code> 时使用 bag 时间轴。
            {" "}
            {BAG_SEEK_CAVEAT_ZH}
            {" "}
            进度为已播放估算（总时长未知）；scrub/seek 为后续工作。
          </p>
          {(pathError || bagNotice || bagStatus?.message) && (
            <p className={`monitor-bag-status ${pathError ? "error" : ""}`}>
              {pathError || bagNotice || bagStatus?.message}
            </p>
          )}
        </section>
      )}

      <div className="monitor-grid-wrap">
        <div className="monitor-grid-toolbar" role="toolbar" aria-label="Monitor 布局与跟随">
          <span>
            {dashboard.panels.length === 0
              ? "空仪表盘"
              : maximizedPanel
                ? `最大化 · ${maximizedPanel.title}`
                : `${dashboard.panels.length} 个 Panel · 窗口 30s`}
            {liveUpdates
              ? (chartsLive ? " · 跟随实时尾部" : " · 等待数据源（Bag 未播放）")
              : " · 已暂停（采样与窗口均冻结）"}
            {layoutLocked ? " · 布局已锁定" : ""}
            {timelineHint}
          </span>
          <div className="monitor-grid-actions">
            <button
              type="button"
              className={liveUpdates ? "" : "active"}
              aria-pressed={!liveUpdates}
              title={liveUpdates ? "暂停采样并冻结时间窗，便于查看尖峰" : "恢复采样并跳回实时尾部"}
              onClick={onToggleLiveUpdates}
            >
              {liveUpdates ? "暂停跟随" : "跟随实时"}
            </button>
            <button
              type="button"
              className={layoutLocked ? "active" : ""}
              aria-pressed={layoutLocked}
              title="锁定后禁止拖拽与缩放"
              onClick={() => onSetLayoutLocked(!layoutLocked)}
            >
              {layoutLocked ? "解锁布局" : "锁定布局"}
            </button>
            <button
              type="button"
              className={compactType === "vertical" ? "active" : ""}
              aria-pressed={compactType === "vertical"}
              title="开启后自动纵向紧凑填补空隙；关闭则允许留白"
              onClick={() =>
                onSetCompactType(compactType === "vertical" ? null : "vertical")
              }
            >
              紧凑排列
            </button>
            <button
              type="button"
              disabled={dashboard.panels.length === 0 || Boolean(maximizedPanel)}
              title="恢复默认 12 列网格打包（如 Motor Torque 7 Panel）"
              onClick={() => onResetLayout(dashboard.id)}
            >
              重置布局
            </button>
            {maximizedPanel && (
              <button
                type="button"
                className="active"
                aria-label="恢复网格"
                title="退出最大化，回到网格"
                onClick={() => setMaximizedPanelId(null)}
              >
                恢复网格
              </button>
            )}
          </div>
        </div>
        {dashboard.panels.length === 0 ? (
          <div className="monitor-grid-empty" role="status">
            从 Topics → Inspector 加入数值字段，或使用「+转矩」模板
          </div>
        ) : maximizedPanel ? (
          <div className="monitor-panel-maximized" data-panel-id={maximizedPanel.id}>
            <div
              className="monitor-panel-drag"
              title="双击恢复网格"
              onDoubleClick={() => toggleMaximize(maximizedPanel.id)}
            >
              <span className="monitor-panel-drag-label">{maximizedPanel.title}</span>
              {renderChartControls(maximizedPanel)}
              <button
                type="button"
                className="monitor-panel-restore"
                aria-label="退出最大化"
                onClick={() => setMaximizedPanelId(null)}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                恢复
              </button>
              <button
                type="button"
                className="monitor-panel-remove"
                aria-label={`移除 ${maximizedPanel.title}`}
                title="移除 Panel"
                onClick={() => onRemovePanel(dashboard.id, maximizedPanel.id)}
                onDoubleClick={(event) => event.stopPropagation()}
              >×</button>
            </div>
            {renderPanelChart(maximizedPanel)}
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
            draggableCancel="button,input,select,textarea,a"
            isDraggable={!layoutLocked}
            isResizable={!layoutLocked}
            compactType={compactType}
            onLayoutChange={(next) => {
              if (layoutLocked) return;
              onLayoutChange(dashboard.id, next);
            }}
          >
            {dashboard.panels.map((panel) => (
              <div key={panel.id} className="monitor-panel-tile" data-panel-id={panel.id}>
                <div
                  className="monitor-panel-drag"
                  title={layoutLocked ? "布局已锁定 · 双击最大化" : "拖拽移动 · 双击最大化"}
                  onDoubleClick={() => toggleMaximize(panel.id)}
                >
                  <span className="monitor-panel-drag-label">{panel.title}</span>
                  {renderChartControls(panel)}
                  <button
                    type="button"
                    className="monitor-panel-remove"
                    aria-label={`移除 ${panel.title}`}
                    title="移除 Panel"
                    onClick={() => onRemovePanel(dashboard.id, panel.id)}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >×</button>
                </div>
                {renderPanelChart(panel)}
              </div>
            ))}
          </ReactGridLayout>
        )}
      </div>
    </main>
  );
}
