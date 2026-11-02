import { clamp } from "./layoutLogic";

export const MOTION_LAYOUT_KEY = "robot-console-motion-layout";
export const defaultMotionLayout = {
  controllersWidth: 280, logHeight: 190, statusWidth: 200, controlsWidth: 300,
  toolsHeight: 240, rgbdHeight: 190, editorWidth: 340, editorHeight: 300,
  groupListWidth: 220, groupPropertiesWidth: 280, groupPreviewHeight: 300, groupPropertiesHeight: 240,
};
export type MotionLayout = typeof defaultMotionLayout;
export type MotionSize = keyof MotionLayout;
export const motionSizeLimits: Record<MotionSize, [number, number]> = {
  controllersWidth: [180, 520], logHeight: [100, 600], statusWidth: [140, 380],
  controlsWidth: [220, 560], toolsHeight: [140, 600], rgbdHeight: [70, 500],
  editorWidth: [260, 700], editorHeight: [140, 700],
  groupListWidth: [150, 420], groupPropertiesWidth: [220, 560], groupPreviewHeight: [120, 500], groupPropertiesHeight: [160, 700],
};
export function boundedMotionSize(key: MotionSize, value: number, available = Infinity) {
  const [min, max] = motionSizeLimits[key];
  return clamp(Number.isFinite(value) ? value : defaultMotionLayout[key], Math.min(min, available), Math.min(max, available));
}
export function loadMotionLayout(storage: Pick<Storage, "getItem"> = localStorage): MotionLayout {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(MOTION_LAYOUT_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaultMotionLayout };
    return Object.fromEntries(Object.entries(defaultMotionLayout).map(([key, fallback]) => {
      const value = (parsed as Record<string, unknown>)[key];
      return [key, boundedMotionSize(key as MotionSize, typeof value === "number" ? value : fallback)];
    })) as MotionLayout;
  } catch { return { ...defaultMotionLayout }; }
}
