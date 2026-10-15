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
};

export type MonitorDashboardPersisted = {
  id: string;
  name: string;
  panels: MonitorPanelPersisted[];
};

export type MonitorWorkspacePersistedV2 = {
  version: 2;
  dashboards: MonitorDashboardPersisted[];
  selectedDashboardId: string;
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
};

export type MonitorDashboard = {
  id: string;
  name: string;
  panels: MonitorPanel[];
};

export type MonitorWorkspace = {
  dashboards: MonitorDashboard[];
  selectedDashboardId: string;
};

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
  return { dashboards: [dashboard], selectedDashboardId: dashboard.id };
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
  };
}

export function persistMonitorWorkspace(workspace: MonitorWorkspace): MonitorWorkspacePersistedV2 {
  return {
    version: MONITOR_STORAGE_VERSION,
    selectedDashboardId: workspace.selectedDashboardId,
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
    return { dashboards, selectedDashboardId };
  }

  if (isV1Persisted(saved)) {
    if (saved.panels.length === 0) return createDefaultMonitorWorkspace(jointStateTopic);
    const dashboards = saved.panels.map(migrateV1PanelToDashboard);
    const selectedDashboardId = dashboards.some((d) => d.id === saved.selectedPanelId)
      ? saved.selectedPanelId
      : dashboards[0]!.id;
    return { dashboards, selectedDashboardId };
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
  return { dashboards: remaining, selectedDashboardId };
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
      const existingFieldIds = new Set(dashboard.panels.map((panel) => panel.series.id));
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
      const nextList = updateSeriesFromMessage([panel.series], topic, data, now);
      const nextSeries = nextList[0]!;
      if (nextSeries === panel.series) return panel;
      dashboardChanged = true;
      return { ...panel, series: nextSeries };
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
  return dashboard.panels.some((panel) => panel.series.id === id);
}

/** @deprecated Use dashboardHasSeries */
export function panelHasSeries(
  dashboard: MonitorDashboard,
  topic: string,
  fieldPath: string,
): boolean {
  return dashboardHasSeries(dashboard, topic, fieldPath);
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
