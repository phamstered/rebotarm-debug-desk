/** Monitor page panels: multi-panel series config with a motor-torque default template. */

import {
  createSeries,
  seriesId,
  updateSeriesFromMessage,
  type DataSeries,
} from "./dataGraphLogic";

export const DEFAULT_TORQUE_JOINT_COUNT = 7;
export const DEFAULT_MONITOR_PANEL_NAME = "Motor Torque";
export const MONITOR_STORAGE_KEY = "robot-console-monitor";

export type MonitorPanelPersisted = {
  id: string;
  name: string;
  series: Array<{ topic: string; fieldPath: string; color: string }>;
};

export type MonitorPanel = {
  id: string;
  name: string;
  series: DataSeries[];
};

export type MonitorWorkspace = {
  panels: MonitorPanel[];
  selectedPanelId: string;
};

export type MonitorWorkspacePersisted = {
  panels: MonitorPanelPersisted[];
  selectedPanelId: string;
};

export function newPanelId(): string {
  return `panel-${crypto.randomUUID()}`;
}

/** Pre-build effort[0..n-1] series for the JointState torque template. */
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

export function createTorquePanel(
  jointStateTopic: string,
  jointCount = DEFAULT_TORQUE_JOINT_COUNT,
  id = newPanelId(),
): MonitorPanel {
  return {
    id,
    name: DEFAULT_MONITOR_PANEL_NAME,
    series: createTorqueSeries(jointStateTopic, jointCount),
  };
}

export function createEmptyPanel(name = "New Panel", id = newPanelId()): MonitorPanel {
  return { id, name, series: [] };
}

export function createDefaultMonitorWorkspace(jointStateTopic: string): MonitorWorkspace {
  const panel = createTorquePanel(jointStateTopic);
  return { panels: [panel], selectedPanelId: panel.id };
}

export function persistMonitorWorkspace(workspace: MonitorWorkspace): MonitorWorkspacePersisted {
  return {
    selectedPanelId: workspace.selectedPanelId,
    panels: workspace.panels.map((panel) => ({
      id: panel.id,
      name: panel.name,
      series: panel.series.map((series) => ({
        topic: series.topic,
        fieldPath: series.fieldPath,
        color: series.color,
      })),
    })),
  };
}

export function hydrateMonitorWorkspace(
  saved: MonitorWorkspacePersisted | null | undefined,
  jointStateTopic: string,
): MonitorWorkspace {
  if (!saved || !Array.isArray(saved.panels) || saved.panels.length === 0) {
    return createDefaultMonitorWorkspace(jointStateTopic);
  }
  const panels: MonitorPanel[] = saved.panels.map((panel, panelIndex) => ({
    id: panel.id || `panel-${panelIndex}`,
    name: panel.name?.trim() || `Panel ${panelIndex + 1}`,
    series: (panel.series ?? []).map((entry, index) => ({
      ...createSeries(entry.topic, entry.fieldPath, index),
      color: entry.color || createSeries(entry.topic, entry.fieldPath, index).color,
      points: [],
    })),
  }));
  const selectedPanelId = panels.some((panel) => panel.id === saved.selectedPanelId)
    ? saved.selectedPanelId
    : panels[0]!.id;
  return { panels, selectedPanelId };
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

export function selectMonitorPanel(workspace: MonitorWorkspace, panelId: string): MonitorWorkspace {
  if (!workspace.panels.some((panel) => panel.id === panelId)) return workspace;
  return { ...workspace, selectedPanelId: panelId };
}

export function addMonitorPanel(workspace: MonitorWorkspace, panel: MonitorPanel): MonitorWorkspace {
  return {
    panels: [...workspace.panels, panel],
    selectedPanelId: panel.id,
  };
}

export function renameMonitorPanel(
  workspace: MonitorWorkspace,
  panelId: string,
  name: string,
): MonitorWorkspace {
  const trimmed = name.trim();
  if (!trimmed) return workspace;
  return {
    ...workspace,
    panels: workspace.panels.map((panel) =>
      panel.id === panelId ? { ...panel, name: trimmed } : panel,
    ),
  };
}

/** Keep at least one panel; deleting the last recreates the torque default. */
export function deleteMonitorPanel(
  workspace: MonitorWorkspace,
  panelId: string,
  jointStateTopic: string,
): MonitorWorkspace {
  const remaining = workspace.panels.filter((panel) => panel.id !== panelId);
  if (remaining.length === 0) {
    return createDefaultMonitorWorkspace(jointStateTopic);
  }
  const selectedPanelId =
    workspace.selectedPanelId === panelId ? remaining[0]!.id : workspace.selectedPanelId;
  return { panels: remaining, selectedPanelId };
}

export function updatePanelSeries(
  workspace: MonitorWorkspace,
  panelId: string,
  series: DataSeries[],
): MonitorWorkspace {
  return {
    ...workspace,
    panels: workspace.panels.map((panel) =>
      panel.id === panelId ? { ...panel, series } : panel,
    ),
  };
}

export function selectedMonitorPanel(workspace: MonitorWorkspace): MonitorPanel | undefined {
  return workspace.panels.find((panel) => panel.id === workspace.selectedPanelId)
    ?? workspace.panels[0];
}

/** Push a live (or bag-replayed) message into every panel that watches the topic. */
export function updateMonitorFromMessage(
  workspace: MonitorWorkspace,
  topic: string,
  data: unknown,
  now: number,
): MonitorWorkspace {
  let changed = false;
  const panels = workspace.panels.map((panel) => {
    if (panel.series.length === 0) return panel;
    const nextSeries = updateSeriesFromMessage(panel.series, topic, data, now);
    if (nextSeries === panel.series) return panel;
    changed = true;
    return { ...panel, series: nextSeries };
  });
  return changed ? { ...workspace, panels } : workspace;
}

export function panelHasSeries(panel: MonitorPanel, topic: string, fieldPath: string): boolean {
  const id = seriesId(topic, fieldPath);
  return panel.series.some((series) => series.id === id);
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
