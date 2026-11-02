export const VIEWER_FLOATING_KEY = "robot-console-viewer-floating-panels-v1";
export const panelIds = ["status", "rgbd", "controls"] as const;
export type ViewerPanelId = typeof panelIds[number];
export type ViewerBounds = { width: number; height: number };
export type FloatingPanelState = { x: number; y: number; width: number; height: number; collapsed: boolean };
export type ViewerFloatingState = Partial<Record<ViewerPanelId, FloatingPanelState>>;
export const FLOATING_HEADER_HEIGHT = 34;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));

export function defaultViewerPanel(id: ViewerPanelId, bounds: ViewerBounds): FloatingPanelState {
  const width = id === "controls" ? Math.min(340, bounds.width * .52) : Math.min(260, bounds.width * .42);
  const height = id === "controls" ? 560 : id === "rgbd" ? Math.min(250, bounds.height * .55) : Math.min(150, bounds.height * .35);
  return boundViewerPanel({ width, height, x: id === "controls" ? bounds.width - width : 0,
    y: id === "rgbd" ? Math.max(0, bounds.height - height) : 0, collapsed: false }, bounds);
}

/** Keep the full frame (or its header when folded) within the current canvas. */
export function boundViewerPanel(panel: FloatingPanelState, bounds: ViewerBounds): FloatingPanelState {
  const width = clamp(panel.width, Math.min(180, bounds.width), bounds.width);
  const height = clamp(panel.height, Math.min(80, bounds.height), bounds.height);
  return { ...panel, width, height, x: clamp(panel.x, 0, Math.max(0, bounds.width - width)),
    y: clamp(panel.y, 0, Math.max(0, bounds.height - (panel.collapsed ? Math.min(FLOATING_HEADER_HEIGHT, bounds.height) : height))) };
}

export function loadViewerFloating(storage: Pick<Storage, "getItem"> = localStorage): ViewerFloatingState {
  try {
    const value = JSON.parse(storage.getItem(VIEWER_FLOATING_KEY) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ViewerFloatingState = {};
    for (const id of panelIds) {
      const panel = value[id];
      if (!panel || ![panel.x, panel.y, panel.width, panel.height].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
        || panel.width === 0 || panel.height === 0 || typeof panel.collapsed !== "boolean") continue;
      result[id] = { x: panel.x, y: panel.y, width: panel.width, height: panel.height, collapsed: panel.collapsed };
    }
    return result;
  } catch { return {}; }
}
