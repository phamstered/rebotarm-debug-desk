/** Monitor dashboards: Grafana-like Dashboard → Panel → Chart with grid layouts. */

import {
  createSeries,
  seriesId,
  updateSeriesFromMessage,
  type DataSeries,
} from "./dataGraphLogic";

export const DEFAULT_TORQUE_JOINT_COUNT = 7;
export const DEFAULT_MONITOR_DASHBOARD_NAME = "Motor Torque";
/** @deprecated Use DEFAULT_MONITOR_DASHBOARD_NAME */
export const DEFAULT_MONITOR_PANEL_NAME = DEFAULT_MONITOR_DASHBOARD_NAME;
export const MONITOR_STORAGE_KEY = "robot-console-monitor";
export const MONITOR_STORAGE_VERSION = 2;
export const MONITOR_GRID_COLS = 12;
export const MONITOR_PANEL_DEFAULT_W = 4;
export const MONITOR_PANEL_DEFAULT_H = 2;
export const MONITOR_PANEL_MIN_W = 3;
export const MONITOR_PANEL_MIN_H = 2;

export type MonitorChartType = "time-series" | "bar" | "pie" | "gauge";
export type MonitorChartConfig = {
  type: MonitorChartType;
  timeStyle: "line" | "points" | "bars";
  barOrientation: "vertical" | "horizontal";
  gaugeMin: number;
  gaugeMax: number;
  gaugeThreshold: number;
};
export const DEFAULT_CHART_CONFIG: MonitorChartConfig = {
  type: "time-series", timeStyle: "line", barOrientation: "vertical",
  gaugeMin: 0, gaugeMax: 100, gaugeThreshold: 80,
};

export function normalizeChartConfig(value: unknown): MonitorChartConfig {
  const raw = value && typeof value === "object" ? value as Partial<MonitorChartConfig> : {};
  const gaugeMin = Number.isFinite(raw.gaugeMin) ? raw.gaugeMin! : 0;
  const gaugeMax = Number.isFinite(raw.gaugeMax) && raw.gaugeMax! > gaugeMin ? raw.gaugeMax! : Math.max(100, gaugeMin + 1);
  return {
    type: raw.type === "bar" || raw.type === "pie" || raw.type === "gauge" ? raw.type : "time-series",
    timeStyle: raw.timeStyle === "points" || raw.timeStyle === "bars" ? raw.timeStyle : "line",
    barOrientation: raw.barOrientation === "horizontal" ? "horizontal" : "vertical",
    gaugeMin, gaugeMax,
    gaugeThreshold: Number.isFinite(raw.gaugeThreshold) ? raw.gaugeThreshold! : 80,
  };
}

export type GridLayoutItem = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type MonitorPanelPersisted = {
  id: string;
  title: string;
  layout: GridLayoutItem;
  series: { topic: string; fieldPath: string; color: string };
  additionalSeries?: Array<{ topic: string; fieldPath: string; color: string }>;
  chart?: Partial<MonitorChartConfig>;
};

export type MonitorDashboardPersisted = {
  id: string;
  name: string;
  panels: MonitorPanelPersisted[];
};

export type MonitorCompactType = "vertical" | "horizontal" | null;

export type MonitorWorkspacePersistedV2 = {
  version: 2;
  dashboards: MonitorDashboardPersisted[];
  selectedDashboardId: string;
  /** When true, drag/resize is disabled. */
  layoutLocked?: boolean;
  /** react-grid-layout compactType; default vertical. */
  compactType?: MonitorCompactType;
};

/** Legacy tab shape (pre-Dashboard rename). */
export type MonitorWorkspacePersistedV1 = {
  panels: Array<{
    id: string;
    name: string;
    series: Array<{ topic: string; fieldPath: string; color: string }>;
  }>;
  selectedPanelId: string;
};

export type MonitorWorkspacePersisted = MonitorWorkspacePersistedV2 | MonitorWorkspacePersistedV1;

export type MonitorPanel = {
  id: string;
  title: string;
  layout: GridLayoutItem;
  series: DataSeries;
  additionalSeries: DataSeries[];
  chart: MonitorChartConfig;
};

export function panelSeries(panel: MonitorPanel): DataSeries[] {
  return [panel.series, ...panel.additionalSeries];
}

export type MonitorDashboard = {
  id: string;
  name: string;
  panels: MonitorPanel[];
};

export type MonitorWorkspace = {
  dashboards: MonitorDashboard[];
  selectedDashboardId: string;
  layoutLocked: boolean;
  compactType: MonitorCompactType;
};

export const DEFAULT_MONITOR_COMPACT_TYPE: MonitorCompactType = "vertical";

export function newDashboardId(): string {
  return `dashboard-${crypto.randomUUID()}`;
}

export function newPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

/** Pack panels into a 12-col grid: w=4 h=2, left-to-right then next row. */
export function packPanelLayouts(
  count: number,
  idForIndex: (index: number) => string,
  cols = MONITOR_GRID_COLS,
  w = MONITOR_PANEL_DEFAULT_W,
  h = MONITOR_PANEL_DEFAULT_H,
): GridLayoutItem[] {
  const perRow = Math.max(1, Math.floor(cols / w));
  const layouts: GridLayoutItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    layouts.push({
      i: idForIndex(index),
      x: col * w,
      y: row * h,
      w,
      h,
    });
  }
  return layouts;
}

/** Next free y for appending panels (max y+h of existing). */
export function nextLayoutY(panels: MonitorPanel[]): number {
  if (panels.length === 0) return 0;
  return Math.max(...panels.map((panel) => panel.layout.y + panel.layout.h));
}

export function createTorqueSeries(
  jointStateTopic: string,
  jointCount = DEFAULT_TORQUE_JOINT_COUNT,
): DataSeries[] {
  const series: DataSeries[] = [];
  for (let index = 0; index < jointCount; index += 1) {
    series.push(createSeries(jointStateTopic, `effort[${index}]`, index));
  }
  return series;
}

export function createPanelFromSeries(
  series: DataSeries,
  layout: GridLayoutItem,
  id = layout.i || newPanelId(),
): MonitorPanel {
  return {
    id,
    title: series.fieldPath,
    layout: { ...layout, i: id },
    series,
    additionalSeries: [],
    chart: { ...DEFAULT_CHART_CONFIG },
  };
}

export function createTorqueDashboard(
  jointStateTopic: string,
  jointCount = DEFAULT_TORQUE_JOINT_COUNT,
  id = newDashboardId(),
): MonitorDashboard {
  const seriesList = createTorqueSeries(jointStateTopic, jointCount);
  const ids = seriesList.map(() => newPanelId());
  const layouts = packPanelLayouts(seriesList.length, (index) => ids[index]!);
  return {
    id,
    name: DEFAULT_MONITOR_DASHBOARD_NAME,
    panels: seriesList.map((series, index) =>
      createPanelFromSeries(series, layouts[index]!, ids[index]),
    ),
  };
}

/** @deprecated Use createTorqueDashboard */
export function createTorquePanel(
  jointStateTopic: string,
  jointCount = DEFAULT_TORQUE_JOINT_COUNT,
  id = newDashboardId(),
): MonitorDashboard {
  return createTorqueDashboard(jointStateTopic, jointCount, id);
}

export function createEmptyDashboard(name = "New Dashboard", id = newDashboardId()): MonitorDashboard {
  return { id, name, panels: [] };
}

/** @deprecated Use createEmptyDashboard */
export function createEmptyPanel(name = "New Dashboard", id = newDashboardId()): MonitorDashboard {
  return createEmptyDashboard(name, id);
}

export function createDefaultMonitorWorkspace(jointStateTopic: string): MonitorWorkspace {
  const dashboard = createTorqueDashboard(jointStateTopic);
  return {
    dashboards: [dashboard],
    selectedDashboardId: dashboard.id,
    layoutLocked: false,
    compactType: DEFAULT_MONITOR_COMPACT_TYPE,
  };
}

function persistPanel(panel: MonitorPanel): MonitorPanelPersisted {
  return {
    id: panel.id,
    title: panel.title,
    layout: {
      i: panel.id,
      x: panel.layout.x,
      y: panel.layout.y,
      w: panel.layout.w,
      h: panel.layout.h,
    },
    series: {
      topic: panel.series.topic,
      fieldPath: panel.series.fieldPath,
      color: panel.series.color,
    },
    additionalSeries: panel.additionalSeries.map(({ topic, fieldPath, color }) => ({ topic, fieldPath, color })),
    chart: panel.chart,
  };
}

export function persistMonitorWorkspace(workspace: MonitorWorkspace): MonitorWorkspacePersistedV2 {
  return {
    version: MONITOR_STORAGE_VERSION,
    selectedDashboardId: workspace.selectedDashboardId,
    layoutLocked: workspace.layoutLocked,
    compactType: workspace.compactType,
    dashboards: workspace.dashboards.map((dashboard) => ({
      id: dashboard.id,
      name: dashboard.name,
      panels: dashboard.panels.map(persistPanel),
    })),
  };
}

function hydratePanel(
  entry: MonitorPanelPersisted,
  panelIndex: number,
  colorFallbackIndex: number,
): MonitorPanel {
  const id = entry.id || `panel-${panelIndex}`;
  const topic = entry.series?.topic || "";
  const fieldPath = entry.series?.fieldPath || `field[${panelIndex}]`;
  const created = createSeries(topic, fieldPath, colorFallbackIndex);
  const layout = entry.layout ?? { i: id, x: 0, y: 0, w: MONITOR_PANEL_DEFAULT_W, h: MONITOR_PANEL_DEFAULT_H };
  return {
    id,
    title: entry.title?.trim() || fieldPath,
    layout: {
      i: id,
      x: Number.isFinite(layout.x) ? layout.x : 0,
      y: Number.isFinite(layout.y) ? layout.y : 0,
      w: Number.isFinite(layout.w) && layout.w > 0 ? layout.w : MONITOR_PANEL_DEFAULT_W,
      h: Number.isFinite(layout.h) && layout.h > 0 ? layout.h : MONITOR_PANEL_DEFAULT_H,
    },
    series: {
      ...created,
      color: entry.series?.color || created.color,
      points: [],
    },
    additionalSeries: (entry.additionalSeries ?? []).filter((series) => series && typeof series.topic === "string" && typeof series.fieldPath === "string").map((series, index) => {
      const createdExtra = createSeries(series.topic, series.fieldPath, colorFallbackIndex + index + 1);
      return { ...createdExtra, color: series.color || createdExtra.color };
    }),
    chart: normalizeChartConfig(entry.chart),
  };
}

function hydrateDashboardV2(
  entry: MonitorDashboardPersisted,
  dashboardIndex: number,
): MonitorDashboard {
  const id = entry.id || `dashboard-${dashboardIndex}`;
  const panels = (entry.panels ?? []).map((panel, panelIndex) =>
    hydratePanel(panel, panelIndex, panelIndex),
  );
  return {
    id,
    name: entry.name?.trim() || `Dashboard ${dashboardIndex + 1}`,
    panels,
  };
}

/** Convert a legacy tab (multi-series) into a Dashboard of one-series Panels. */
export function migrateV1PanelToDashboard(
  panel: MonitorWorkspacePersistedV1["panels"][number],
  panelIndex: number,
): MonitorDashboard {
  const id = panel.id || `dashboard-${panelIndex}`;
  const seriesEntries = panel.series ?? [];
  const panelIds = seriesEntries.map((_, index) => `panel-${id}-${index}`);
  const layouts = packPanelLayouts(seriesEntries.length, (index) => panelIds[index]!);
  return {
    id,
    name: panel.name?.trim() || `Dashboard ${panelIndex + 1}`,
    panels: seriesEntries.map((entry, index) => {
      const panelId = panelIds[index]!;
      const created = createSeries(entry.topic, entry.fieldPath, index);
      return {
        id: panelId,
        title: entry.fieldPath,
        layout: layouts[index]!,
        series: {
          ...created,
          color: entry.color || created.color,
          points: [],
        },
        additionalSeries: [],
        chart: { ...DEFAULT_CHART_CONFIG },
      };
    }),
  };
}

function isV2Persisted(saved: MonitorWorkspacePersisted): saved is MonitorWorkspacePersistedV2 {
  return (
    typeof saved === "object"
    && saved !== null
    && "dashboards" in saved
    && Array.isArray((saved as MonitorWorkspacePersistedV2).dashboards)
  );
}

function isV1Persisted(saved: MonitorWorkspacePersisted): saved is MonitorWorkspacePersistedV1 {
  return (
    typeof saved === "object"
    && saved !== null
    && "panels" in saved
    && Array.isArray((saved as MonitorWorkspacePersistedV1).panels)
    && !("dashboards" in saved)
  );
}

export function hydrateMonitorWorkspace(
  saved: MonitorWorkspacePersisted | null | undefined,
  jointStateTopic: string,
): MonitorWorkspace {
  if (!saved) return createDefaultMonitorWorkspace(jointStateTopic);

  if (isV2Persisted(saved)) {
    if (saved.dashboards.length === 0) return createDefaultMonitorWorkspace(jointStateTopic);
    const dashboards = saved.dashboards.map(hydrateDashboardV2);
    const selectedDashboardId = dashboards.some((d) => d.id === saved.selectedDashboardId)
      ? saved.selectedDashboardId
      : dashboards[0]!.id;
    return {
      dashboards,
      selectedDashboardId,
      layoutLocked: Boolean(saved.layoutLocked),
      compactType: normalizeCompactType(saved.compactType),
    };
  }

  if (isV1Persisted(saved)) {
    if (saved.panels.length === 0) return createDefaultMonitorWorkspace(jointStateTopic);
    const dashboards = saved.panels.map(migrateV1PanelToDashboard);
    const selectedDashboardId = dashboards.some((d) => d.id === saved.selectedPanelId)
      ? saved.selectedPanelId
      : dashboards[0]!.id;
    return {
      dashboards,
      selectedDashboardId,
      layoutLocked: false,
      compactType: DEFAULT_MONITOR_COMPACT_TYPE,
    };
  }

  return createDefaultMonitorWorkspace(jointStateTopic);
}

export function loadMonitorWorkspace(
  jointStateTopic: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): MonitorWorkspace {
  try {
    const raw = storage.getItem(MONITOR_STORAGE_KEY);
    if (!raw) return createDefaultMonitorWorkspace(jointStateTopic);
    return hydrateMonitorWorkspace(JSON.parse(raw) as MonitorWorkspacePersisted, jointStateTopic);
  } catch {
    return createDefaultMonitorWorkspace(jointStateTopic);
  }
}

export function saveMonitorWorkspace(
  workspace: MonitorWorkspace,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(persistMonitorWorkspace(workspace)));
}

export function selectMonitorDashboard(
  workspace: MonitorWorkspace,
  dashboardId: string,
): MonitorWorkspace {
  if (!workspace.dashboards.some((dashboard) => dashboard.id === dashboardId)) return workspace;
  return { ...workspace, selectedDashboardId: dashboardId };
}

/** @deprecated Use selectMonitorDashboard */
export function selectMonitorPanel(
  workspace: MonitorWorkspace,
  dashboardId: string,
): MonitorWorkspace {
  return selectMonitorDashboard(workspace, dashboardId);
}

export function addMonitorDashboard(
  workspace: MonitorWorkspace,
  dashboard: MonitorDashboard,
): MonitorWorkspace {
  return {
    ...workspace,
    dashboards: [...workspace.dashboards, dashboard],
    selectedDashboardId: dashboard.id,
  };
}

/** @deprecated Use addMonitorDashboard */
export function addMonitorPanel(
  workspace: MonitorWorkspace,
  dashboard: MonitorDashboard,
): MonitorWorkspace {
  return addMonitorDashboard(workspace, dashboard);
}

export function renameMonitorDashboard(
  workspace: MonitorWorkspace,
  dashboardId: string,
  name: string,
): MonitorWorkspace {
  const trimmed = name.trim();
  if (!trimmed) return workspace;
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) =>
      dashboard.id === dashboardId ? { ...dashboard, name: trimmed } : dashboard,
    ),
  };
}

/** @deprecated Use renameMonitorDashboard */
export function renameMonitorPanel(
  workspace: MonitorWorkspace,
  dashboardId: string,
  name: string,
): MonitorWorkspace {
  return renameMonitorDashboard(workspace, dashboardId, name);
}

/** Keep at least one dashboard; deleting the last recreates the torque default. */
export function deleteMonitorDashboard(
  workspace: MonitorWorkspace,
  dashboardId: string,
  jointStateTopic: string,
): MonitorWorkspace {
  const remaining = workspace.dashboards.filter((dashboard) => dashboard.id !== dashboardId);
  if (remaining.length === 0) {
    return createDefaultMonitorWorkspace(jointStateTopic);
  }
  const selectedDashboardId =
    workspace.selectedDashboardId === dashboardId
      ? remaining[0]!.id
      : workspace.selectedDashboardId;
  return {
    dashboards: remaining,
    selectedDashboardId,
    layoutLocked: workspace.layoutLocked,
    compactType: workspace.compactType,
  };
}

/** @deprecated Use deleteMonitorDashboard */
export function deleteMonitorPanel(
  workspace: MonitorWorkspace,
  dashboardId: string,
  jointStateTopic: string,
): MonitorWorkspace {
  return deleteMonitorDashboard(workspace, dashboardId, jointStateTopic);
}

export function selectedMonitorDashboard(
  workspace: MonitorWorkspace,
): MonitorDashboard | undefined {
  return (
    workspace.dashboards.find((dashboard) => dashboard.id === workspace.selectedDashboardId)
    ?? workspace.dashboards[0]
  );
}

/** @deprecated Use selectedMonitorDashboard */
export function selectedMonitorPanel(
  workspace: MonitorWorkspace,
): MonitorDashboard | undefined {
  return selectedMonitorDashboard(workspace);
}

export function updateDashboardLayout(
  workspace: MonitorWorkspace,
  dashboardId: string,
  layouts: GridLayoutItem[],
): MonitorWorkspace {
  const byId = new Map(layouts.map((layout) => [layout.i, layout]));
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      return {
        ...dashboard,
        panels: dashboard.panels.map((panel) => {
          const layout = byId.get(panel.id);
          if (!layout) return panel;
          return {
            ...panel,
            layout: {
              i: panel.id,
              x: layout.x,
              y: layout.y,
              w: layout.w,
              h: layout.h,
            },
          };
        }),
      };
    }),
  };
}

export function addPanelsToDashboard(
  workspace: MonitorWorkspace,
  dashboardId: string,
  seriesList: DataSeries[],
): MonitorWorkspace {
  if (seriesList.length === 0) return workspace;
  return {
    ...workspace,
    selectedDashboardId: workspace.dashboards.some((d) => d.id === dashboardId)
      ? dashboardId
      : workspace.selectedDashboardId,
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      const startY = nextLayoutY(dashboard.panels);
      const existingFieldIds = new Set(dashboard.panels.flatMap((panel) => panelSeries(panel).map((series) => series.id)));
      const toAdd = seriesList.filter((series) => !existingFieldIds.has(series.id));
      if (toAdd.length === 0) return dashboard;
      const ids = toAdd.map(() => newPanelId());
      const layouts = packPanelLayouts(toAdd.length, (index) => ids[index]!);
      const newPanels = toAdd.map((series, index) => {
        const layout = layouts[index]!;
        return createPanelFromSeries(
          series,
          { ...layout, y: layout.y + startY },
          ids[index],
        );
      });
      return { ...dashboard, panels: [...dashboard.panels, ...newPanels] };
    }),
  };
}

/** Add fields to an existing Panel, or create one Panel containing all selected fields. */
export function addSeriesToDashboardPanel(
  workspace: MonitorWorkspace,
  dashboardId: string,
  panelId: string | null,
  seriesList: DataSeries[],
): MonitorWorkspace {
  if (seriesList.length === 0 || !workspace.dashboards.some((dashboard) => dashboard.id === dashboardId)) return workspace;
  return {
    ...workspace,
    selectedDashboardId: dashboardId,
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      if (panelId === null) {
        const id = newPanelId();
        const layout = { i: id, x: 0, y: nextLayoutY(dashboard.panels), w: MONITOR_PANEL_DEFAULT_W, h: MONITOR_PANEL_DEFAULT_H };
        const panel = createPanelFromSeries(seriesList[0]!, layout, id);
        return { ...dashboard, panels: [...dashboard.panels, { ...panel, additionalSeries: seriesList.slice(1) }] };
      }
      return {
        ...dashboard,
        panels: dashboard.panels.map((panel) => {
          if (panel.id !== panelId) return panel;
          const existing = new Set(panelSeries(panel).map((series) => series.id));
          const toAdd = seriesList.filter((series) => {
            if (existing.has(series.id)) return false;
            existing.add(series.id);
            return true;
          });
          return toAdd.length ? { ...panel, additionalSeries: [...panel.additionalSeries, ...toAdd] } : panel;
        }),
      };
    }),
  };
}

export function updatePanelChart(
  workspace: MonitorWorkspace,
  dashboardId: string,
  panelId: string,
  chart: Partial<MonitorChartConfig>,
): MonitorWorkspace {
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) => dashboard.id !== dashboardId ? dashboard : {
      ...dashboard,
      panels: dashboard.panels.map((panel) => panel.id !== panelId ? panel : {
        ...panel,
        chart: normalizeChartConfig({ ...panel.chart, ...chart }),
      }),
    }),
  };
}

export function removePanelFromDashboard(
  workspace: MonitorWorkspace,
  dashboardId: string,
  panelId: string,
): MonitorWorkspace {
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      return {
        ...dashboard,
        panels: dashboard.panels.filter((panel) => panel.id !== panelId),
      };
    }),
  };
}

export function clearDashboardPanels(
  workspace: MonitorWorkspace,
  dashboardId: string,
): MonitorWorkspace {
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) =>
      dashboard.id === dashboardId ? { ...dashboard, panels: [] } : dashboard,
    ),
  };
}

/** Replace all panels on a dashboard from a series list (used rarely; prefer addPanelsToDashboard). */
export function updateDashboardPanelsFromSeries(
  workspace: MonitorWorkspace,
  dashboardId: string,
  seriesList: DataSeries[],
): MonitorWorkspace {
  const ids = seriesList.map(() => newPanelId());
  const layouts = packPanelLayouts(seriesList.length, (index) => ids[index]!);
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      return {
        ...dashboard,
        panels: seriesList.map((series, index) =>
          createPanelFromSeries(series, layouts[index]!, ids[index]),
        ),
      };
    }),
  };
}

/** @deprecated Prefer addPanelsToDashboard / clearDashboardPanels */
export function updatePanelSeries(
  workspace: MonitorWorkspace,
  dashboardId: string,
  series: DataSeries[],
): MonitorWorkspace {
  return updateDashboardPanelsFromSeries(workspace, dashboardId, series);
}

/** Push a live (or bag-replayed) message into every panel that watches the topic. */
export function updateMonitorFromMessage(
  workspace: MonitorWorkspace,
  topic: string,
  data: unknown,
  now: number,
): MonitorWorkspace {
  let changed = false;
  const dashboards = workspace.dashboards.map((dashboard) => {
    if (dashboard.panels.length === 0) return dashboard;
    let dashboardChanged = false;
    const panels = dashboard.panels.map((panel) => {
      const nextList = updateSeriesFromMessage(panelSeries(panel), topic, data, now);
      if (nextList[0] === panel.series && nextList.slice(1).every((series, index) => series === panel.additionalSeries[index])) return panel;
      dashboardChanged = true;
      return { ...panel, series: nextList[0]!, additionalSeries: nextList.slice(1) };
    });
    if (!dashboardChanged) return dashboard;
    changed = true;
    return { ...dashboard, panels };
  });
  return changed ? { ...workspace, dashboards } : workspace;
}

export function dashboardHasSeries(
  dashboard: MonitorDashboard,
  topic: string,
  fieldPath: string,
): boolean {
  const id = seriesId(topic, fieldPath);
  return dashboard.panels.some((panel) => panelSeries(panel).some((series) => series.id === id));
}

/** @deprecated Use dashboardHasSeries */
export function panelHasSeries(
  dashboard: MonitorDashboard,
  topic: string,
  fieldPath: string,
): boolean {
  return dashboardHasSeries(dashboard, topic, fieldPath);
}

export function normalizeCompactType(value: unknown): MonitorCompactType {
  if (value === "vertical" || value === "horizontal" || value === null) return value;
  return DEFAULT_MONITOR_COMPACT_TYPE;
}

export function setMonitorLayoutLocked(
  workspace: MonitorWorkspace,
  layoutLocked: boolean,
): MonitorWorkspace {
  if (workspace.layoutLocked === layoutLocked) return workspace;
  return { ...workspace, layoutLocked };
}

export function setMonitorCompactType(
  workspace: MonitorWorkspace,
  compactType: MonitorCompactType,
): MonitorWorkspace {
  if (workspace.compactType === compactType) return workspace;
  return { ...workspace, compactType };
}

/** Re-pack current panels into the default 12-col Motor Torque-style grid (keeps series). */
export function resetDashboardPanelLayouts(
  workspace: MonitorWorkspace,
  dashboardId: string,
): MonitorWorkspace {
  return {
    ...workspace,
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      if (dashboard.panels.length === 0) return dashboard;
      const layouts = packPanelLayouts(dashboard.panels.length, (index) => dashboard.panels[index]!.id);
      return {
        ...dashboard,
        panels: dashboard.panels.map((panel, index) => ({
          ...panel,
          layout: layouts[index]!,
        })),
      };
    }),
  };
}

/** Validate Jetson bag path for SSH play (same charset rules as ROS setup script). */
export function isSafeBagPath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (!path.split("").every((character) => /[A-Za-z0-9._\-/]/.test(character))) return false;
  const body = path.startsWith("/") ? path.slice(1) : path;
  if (!body) return false;
  return body.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("-"),
  );
}

/* ── Layout presets (Foxglove-style named panel layouts) ─────────────────── */

export const MONITOR_LAYOUT_PRESETS_KEY = "robot-console-monitor-layout-presets";
export const MONITOR_LAYOUT_PRESETS_VERSION = 1 as const;

export type MonitorLayoutPresetPanel = {
  title: string;
  layout: GridLayoutItem;
  series: { topic: string; fieldPath: string; color: string };
  additionalSeries?: Array<{ topic: string; fieldPath: string; color: string }>;
  chart?: Partial<MonitorChartConfig>;
};

export type MonitorLayoutPreset = {
  id: string;
  name: string;
  savedAt: string;
  panels: MonitorLayoutPresetPanel[];
  layoutLocked?: boolean;
  compactType?: MonitorCompactType;
};

export type MonitorLayoutPresetBundle = {
  version: typeof MONITOR_LAYOUT_PRESETS_VERSION;
  presets: MonitorLayoutPreset[];
};

export function newLayoutPresetId(): string {
  return `layout-${crypto.randomUUID()}`;
}

export function createLayoutPresetFromDashboard(
  dashboard: MonitorDashboard,
  name: string,
  options?: { layoutLocked?: boolean; compactType?: MonitorCompactType; id?: string; savedAt?: string },
): MonitorLayoutPreset | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return {
    id: options?.id ?? newLayoutPresetId(),
    name: trimmed,
    savedAt: options?.savedAt ?? new Date().toISOString(),
    layoutLocked: options?.layoutLocked,
    compactType: options?.compactType,
    panels: dashboard.panels.map((panel) => ({
      title: panel.title,
      layout: {
        i: panel.id,
        x: panel.layout.x,
        y: panel.layout.y,
        w: panel.layout.w,
        h: panel.layout.h,
      },
      series: {
        topic: panel.series.topic,
        fieldPath: panel.series.fieldPath,
        color: panel.series.color,
      },
      additionalSeries: panel.additionalSeries.map(({ topic, fieldPath, color }) => ({ topic, fieldPath, color })),
      chart: panel.chart,
    })),
  };
}

function hydratePresetPanel(
  entry: MonitorLayoutPresetPanel,
  panelIndex: number,
): MonitorPanel {
  const id = newPanelId();
  const topic = entry.series?.topic || "";
  const fieldPath = entry.series?.fieldPath || `field[${panelIndex}]`;
  const created = createSeries(topic, fieldPath, panelIndex);
  const layout = entry.layout ?? {
    i: id,
    x: 0,
    y: 0,
    w: MONITOR_PANEL_DEFAULT_W,
    h: MONITOR_PANEL_DEFAULT_H,
  };
  return {
    id,
    title: entry.title?.trim() || fieldPath,
    layout: {
      i: id,
      x: Number.isFinite(layout.x) ? layout.x : 0,
      y: Number.isFinite(layout.y) ? layout.y : 0,
      w: Number.isFinite(layout.w) && layout.w > 0 ? layout.w : MONITOR_PANEL_DEFAULT_W,
      h: Number.isFinite(layout.h) && layout.h > 0 ? layout.h : MONITOR_PANEL_DEFAULT_H,
    },
    series: {
      ...created,
      color: entry.series?.color || created.color,
      points: [],
    },
    additionalSeries: (entry.additionalSeries ?? []).map((series, index) => {
      const extra = createSeries(series.topic, series.fieldPath, panelIndex + index + 1);
      return { ...extra, color: series.color || extra.color };
    }),
    chart: normalizeChartConfig(entry.chart),
  };
}

/** Replace panels on a dashboard from a named layout preset (keeps dashboard id/name). */
export function applyLayoutPresetToDashboard(
  workspace: MonitorWorkspace,
  dashboardId: string,
  preset: MonitorLayoutPreset,
): MonitorWorkspace {
  const panels = (preset.panels ?? []).map((entry, index) => hydratePresetPanel(entry, index));
  return {
    ...workspace,
    layoutLocked:
      preset.layoutLocked === undefined ? workspace.layoutLocked : Boolean(preset.layoutLocked),
    compactType:
      preset.compactType === undefined
        ? workspace.compactType
        : normalizeCompactType(preset.compactType),
    dashboards: workspace.dashboards.map((dashboard) => {
      if (dashboard.id !== dashboardId) return dashboard;
      return { ...dashboard, panels };
    }),
  };
}

export function normalizeLayoutPreset(raw: unknown): MonitorLayoutPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Partial<MonitorLayoutPreset>;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  const panels = Array.isArray(entry.panels) ? entry.panels : [];
  const normalizedPanels: MonitorLayoutPresetPanel[] = [];
  for (const panel of panels) {
    if (!panel || typeof panel !== "object") continue;
    const series = (panel as MonitorLayoutPresetPanel).series;
    if (!series || typeof series.topic !== "string" || typeof series.fieldPath !== "string") continue;
    const layout = (panel as MonitorLayoutPresetPanel).layout;
    normalizedPanels.push({
      title: typeof (panel as MonitorLayoutPresetPanel).title === "string"
        ? (panel as MonitorLayoutPresetPanel).title
        : series.fieldPath,
      layout: {
        i: typeof layout?.i === "string" ? layout.i : `panel-${normalizedPanels.length}`,
        x: Number.isFinite(layout?.x) ? layout!.x : 0,
        y: Number.isFinite(layout?.y) ? layout!.y : 0,
        w: Number.isFinite(layout?.w) && layout!.w > 0 ? layout!.w : MONITOR_PANEL_DEFAULT_W,
        h: Number.isFinite(layout?.h) && layout!.h > 0 ? layout!.h : MONITOR_PANEL_DEFAULT_H,
      },
      series: {
        topic: series.topic,
        fieldPath: series.fieldPath,
        color: typeof series.color === "string" ? series.color : "#42d6c7",
      },
      additionalSeries: Array.isArray((panel as MonitorLayoutPresetPanel).additionalSeries)
        ? (panel as MonitorLayoutPresetPanel).additionalSeries!.filter((entry) => entry && typeof entry.topic === "string" && typeof entry.fieldPath === "string").map((entry) => ({ topic: entry.topic, fieldPath: entry.fieldPath, color: typeof entry.color === "string" ? entry.color : "#42d6c7" }))
        : [],
      chart: normalizeChartConfig((panel as MonitorLayoutPresetPanel).chart),
    });
  }
  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : newLayoutPresetId(),
    name,
    savedAt: typeof entry.savedAt === "string" ? entry.savedAt : new Date().toISOString(),
    panels: normalizedPanels,
    layoutLocked: entry.layoutLocked === undefined ? undefined : Boolean(entry.layoutLocked),
    compactType: entry.compactType === undefined ? undefined : normalizeCompactType(entry.compactType),
  };
}

export function hydrateLayoutPresetBundle(raw: unknown): MonitorLayoutPreset[] {
  if (!raw || typeof raw !== "object") return [];
  const bundle = raw as Partial<MonitorLayoutPresetBundle>;
  const list = Array.isArray(bundle.presets)
    ? bundle.presets
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  const presets: MonitorLayoutPreset[] = [];
  for (const entry of list) {
    const preset = normalizeLayoutPreset(entry);
    if (preset) presets.push(preset);
  }
  return presets;
}

export function persistLayoutPresetBundle(presets: MonitorLayoutPreset[]): MonitorLayoutPresetBundle {
  return { version: MONITOR_LAYOUT_PRESETS_VERSION, presets };
}

export function loadLayoutPresets(
  storage: Pick<Storage, "getItem"> = localStorage,
): MonitorLayoutPreset[] {
  try {
    const raw = storage.getItem(MONITOR_LAYOUT_PRESETS_KEY);
    if (!raw) return [];
    return hydrateLayoutPresetBundle(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function saveLayoutPresets(
  presets: MonitorLayoutPreset[],
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(MONITOR_LAYOUT_PRESETS_KEY, JSON.stringify(persistLayoutPresetBundle(presets)));
}

export function upsertLayoutPreset(
  presets: MonitorLayoutPreset[],
  preset: MonitorLayoutPreset,
): MonitorLayoutPreset[] {
  const index = presets.findIndex((entry) => entry.id === preset.id);
  if (index < 0) return [...presets, preset];
  const next = presets.slice();
  next[index] = preset;
  return next;
}

export function deleteLayoutPreset(
  presets: MonitorLayoutPreset[],
  presetId: string,
): MonitorLayoutPreset[] {
  return presets.filter((entry) => entry.id !== presetId);
}

export function exportLayoutPresetsJson(presets: MonitorLayoutPreset[]): string {
  return `${JSON.stringify(persistLayoutPresetBundle(presets), null, 2)}\n`;
}

export function importLayoutPresetsJson(
  json: string,
  existing: MonitorLayoutPreset[],
): { presets: MonitorLayoutPreset[]; imported: number; error?: string } {
  try {
    const parsed = JSON.parse(json) as unknown;
    const incoming = hydrateLayoutPresetBundle(parsed);
    if (incoming.length === 0) {
      return { presets: existing, imported: 0, error: "JSON 中没有可用的布局预设" };
    }
    let next = existing;
    for (const preset of incoming) {
      // Re-id on import to avoid clobbering local ids with same name.
      const withNewId: MonitorLayoutPreset = {
        ...preset,
        id: newLayoutPresetId(),
        savedAt: new Date().toISOString(),
      };
      next = upsertLayoutPreset(next, withNewId);
    }
    return { presets: next, imported: incoming.length };
  } catch (reason) {
    return {
      presets: existing,
      imported: 0,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}
