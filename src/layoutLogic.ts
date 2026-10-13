export type LayoutSizes = {
  leftWidth: number;
  rightWidth: number;
  leftTopRatio: number;
};

export const defaultLayoutSizes: LayoutSizes = {
  leftWidth: 270,
  rightWidth: 330,
  leftTopRatio: 0.64,
};

const LEFT_MIN = 180;
const LEFT_MAX = 480;
const RIGHT_MIN = 260;
const RIGHT_MAX = 560;
const CENTER_MIN = 420;
const RATIO_MIN = 0.18;
const RATIO_MAX = 0.82;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeLayoutSizes(saved: Partial<LayoutSizes>): LayoutSizes {
  return {
    leftWidth: clamp(finiteOr(saved.leftWidth, defaultLayoutSizes.leftWidth), LEFT_MIN, LEFT_MAX),
    rightWidth: clamp(finiteOr(saved.rightWidth, defaultLayoutSizes.rightWidth), RIGHT_MIN, RIGHT_MAX),
    leftTopRatio: clamp(finiteOr(saved.leftTopRatio, defaultLayoutSizes.leftTopRatio), RATIO_MIN, RATIO_MAX),
  };
}

export function loadLayoutSizes(storage: Pick<Storage, "getItem"> = localStorage): LayoutSizes {
  try {
    const saved = storage.getItem("easy-debug-layout");
    return saved ? normalizeLayoutSizes(JSON.parse(saved) as Partial<LayoutSizes>) : defaultLayoutSizes;
  } catch {
    return defaultLayoutSizes;
  }
}

export function resizeColumn(
  side: "left" | "right",
  clientX: number,
  viewportWidth: number,
  current: LayoutSizes,
): LayoutSizes {
  if (side === "left") {
    const availableMaximum = Math.max(LEFT_MIN, viewportWidth - current.rightWidth - CENTER_MIN);
    return { ...current, leftWidth: clamp(clientX, LEFT_MIN, Math.min(LEFT_MAX, availableMaximum)) };
  }
  const availableMaximum = Math.max(RIGHT_MIN, viewportWidth - current.leftWidth - CENTER_MIN);
  return {
    ...current,
    rightWidth: clamp(viewportWidth - clientX, RIGHT_MIN, Math.min(RIGHT_MAX, availableMaximum)),
  };
}

export function resizeSplit(clientY: number, containerTop: number, containerHeight: number): number {
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) return 0.5;
  return clamp((clientY - containerTop) / containerHeight, RATIO_MIN, RATIO_MAX);
}
