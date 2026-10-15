/** Sliding-window live series for Monitor panels / DataGraph charts (v1: single topic per panel). */

export const DATA_GRAPH_WINDOW_MS = 30_000;
export const DATA_GRAPH_MAX_POINTS = 8_000;

export type DataPoint = { t: number; value: number };

export type DataSeries = {
  id: string;
  topic: string;
  fieldPath: string;
  label: string;
  color: string;
  points: DataPoint[];
};

export type NumericFieldInfo = {
  path: string;
  kind: "scalar" | "array";
  length?: number;
};

export type PathSegment = { key: string; index?: number };

const SERIES_COLORS = [
  "#42d6c7",
  "#5b9dff",
  "#f0b429",
  "#e879f9",
  "#34d399",
  "#fb7185",
  "#a78bfa",
  "#38bdf8",
  "#fbbf24",
  "#f472b6",
];

export function seriesId(topic: string, fieldPath: string): string {
  return `${topic}::${fieldPath}`;
}

export function nextSeriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!;
}

export function parsePathSegments(path: string): PathSegment[] {
  if (!path) return [];
  const segments: PathSegment[] = [];
  for (const part of path.split(".")) {
    const match = /^(.*?)(?:\[(\d+)\])?$/.exec(part);
    if (!match || !match[1]) continue;
    const index = match[2] === undefined ? undefined : Number(match[2]);
    segments.push(index === undefined ? { key: match[1] } : { key: match[1], index });
  }
  return segments;
}

export function getNumericAtPath(data: unknown, path: string): number | undefined {
  let current: unknown = data;
  for (const segment of parsePathSegments(path)) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment.key];
    if (segment.index !== undefined) {
      if (!Array.isArray(current)) return undefined;
      current = current[segment.index];
    }
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

export function listNumericFields(data: unknown, prefix = ""): NumericFieldInfo[] {
  if (data == null) return [];
  if (typeof data === "number" && Number.isFinite(data)) {
    return prefix ? [{ path: prefix, kind: "scalar" }] : [];
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    if (data.every((item) => typeof item === "number" && Number.isFinite(item))) {
      return prefix ? [{ path: prefix, kind: "array", length: data.length }] : [];
    }
    const nested: NumericFieldInfo[] = [];
    data.forEach((item, index) => {
      const childPrefix = prefix ? `${prefix}[${index}]` : `[${index}]`;
      nested.push(...listNumericFields(item, childPrefix));
    });
    return nested;
  }
  if (typeof data !== "object") return [];
  const fields: NumericFieldInfo[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === "data_base64" || key === "data_length") continue;
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number" && Number.isFinite(value)) {
      fields.push({ path: childPrefix, kind: "scalar" });
      continue;
    }
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item))) {
      fields.push({ path: childPrefix, kind: "array", length: value.length });
      continue;
    }
    fields.push(...listNumericFields(value, childPrefix));
  }
  return fields;
}

/** Expand an array field path into per-index series paths using the current message. */
export function expandFieldPaths(fieldPath: string, data: unknown): string[] {
  const value = resolvePathValue(data, fieldPath);
  if (Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return value.map((_, index) => `${fieldPath}[${index}]`);
  }
  if (typeof value === "number" && Number.isFinite(value)) return [fieldPath];
  // Already an indexed path, or missing — try as-is.
  if (getNumericAtPath(data, fieldPath) !== undefined) return [fieldPath];
  return [];
}

function resolvePathValue(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of parsePathSegments(path)) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment.key];
    if (segment.index !== undefined) {
      if (!Array.isArray(current)) return undefined;
      current = current[segment.index];
    }
  }
  return current;
}

export function prunePoints(points: DataPoint[], now: number, windowMs = DATA_GRAPH_WINDOW_MS): DataPoint[] {
  const cutoff = now - windowMs;
  let start = 0;
  while (start < points.length && points[start]!.t < cutoff) start += 1;
  let next = start > 0 ? points.slice(start) : points;
  if (next.length > DATA_GRAPH_MAX_POINTS) {
    next = next.slice(next.length - DATA_GRAPH_MAX_POINTS);
  }
  return next;
}

export function appendSeriesPoint(
  series: DataSeries,
  t: number,
  value: number,
  windowMs = DATA_GRAPH_WINDOW_MS,
): DataSeries {
  return {
    ...series,
    points: prunePoints([...series.points, { t, value }], t, windowMs),
  };
}

export function updateSeriesFromMessage(
  seriesList: DataSeries[],
  topic: string,
  data: unknown,
  now: number,
  windowMs = DATA_GRAPH_WINDOW_MS,
): DataSeries[] {
  let changed = false;
  const next = seriesList.map((series) => {
    if (series.topic !== topic) {
      const pruned = prunePoints(series.points, now, windowMs);
      if (pruned.length !== series.points.length) {
        changed = true;
        return { ...series, points: pruned };
      }
      return series;
    }
    const value = getNumericAtPath(data, series.fieldPath);
    if (value === undefined) {
      const pruned = prunePoints(series.points, now, windowMs);
      if (pruned.length !== series.points.length) {
        changed = true;
        return { ...series, points: pruned };
      }
      return series;
    }
    changed = true;
    return appendSeriesPoint(series, now, value, windowMs);
  });
  return changed ? next : seriesList;
}

export function createSeries(
  topic: string,
  fieldPath: string,
  colorIndex: number,
  initial?: { t: number; value: number },
): DataSeries {
  const points = initial ? [{ t: initial.t, value: initial.value }] : [];
  return {
    id: seriesId(topic, fieldPath),
    topic,
    fieldPath,
    label: `${topic} · ${fieldPath}`,
    color: nextSeriesColor(colorIndex),
    points,
  };
}

/**
 * Add field(s) for a topic. v1 is single-topic: adding from another topic replaces existing series.
 * Array fields expand to one series per index.
 */
export function addFieldsToSeries(
  current: DataSeries[],
  topic: string,
  fieldPath: string,
  data: unknown,
  now = performance.now(),
): DataSeries[] {
  const paths = expandFieldPaths(fieldPath, data);
  if (paths.length === 0) return current;

  const sameTopic = current.length === 0 || current.every((series) => series.topic === topic);
  const base = sameTopic ? current : [];
  const existingIds = new Set(base.map((series) => series.id));
  const added: DataSeries[] = [];
  let colorIndex = base.length;

  for (const path of paths) {
    const id = seriesId(topic, path);
    if (existingIds.has(id)) continue;
    const value = getNumericAtPath(data, path);
    added.push(createSeries(topic, path, colorIndex, value === undefined ? undefined : { t: now, value }));
    existingIds.add(id);
    colorIndex += 1;
  }

  return added.length === 0 ? base : [...base, ...added];
}

export function removeSeries(current: DataSeries[], id: string): DataSeries[] {
  return current.filter((series) => series.id !== id);
}

export type PlotBounds = { minT: number; maxT: number; minY: number; maxY: number };

export function computePlotBounds(seriesList: DataSeries[], now: number, windowMs = DATA_GRAPH_WINDOW_MS): PlotBounds {
  const maxT = now;
  const minT = now - windowMs;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const series of seriesList) {
    for (const point of series.points) {
      if (point.t < minT || point.t > maxT) continue;
      if (point.value < minY) minY = point.value;
      if (point.value > maxY) maxY = point.value;
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    return { minT, maxT, minY: -1, maxY: 1 };
  }
  if (minY === maxY) {
    const pad = Math.max(Math.abs(minY) * 0.1, 1);
    return { minT, maxT, minY: minY - pad, maxY: maxY + pad };
  }
  const pad = (maxY - minY) * 0.08;
  return { minT, maxT, minY: minY - pad, maxY: maxY + pad };
}

/** Map a canvas x (CSS px within canvas) to a timestamp in [minT, maxT]. */
export function timestampFromPlotX(
  x: number,
  plotLeft: number,
  plotWidth: number,
  minT: number,
  maxT: number,
): number {
  if (plotWidth <= 0) return minT;
  const ratio = Math.max(0, Math.min(1, (x - plotLeft) / plotWidth));
  return minT + ratio * (maxT - minT);
}

/** Map a timestamp to canvas x within the plot. */
export function plotXFromTimestamp(
  t: number,
  plotLeft: number,
  plotWidth: number,
  minT: number,
  maxT: number,
): number {
  const span = Math.max(maxT - minT, 1);
  return plotLeft + ((t - minT) / span) * plotWidth;
}

/** Nearest sample value at or before t (for crosshair readout). */
export function nearestValueAtTime(points: DataPoint[], t: number): number | undefined {
  if (points.length === 0) return undefined;
  let best: DataPoint | undefined;
  for (const point of points) {
    if (point.t > t) break;
    best = point;
  }
  return best?.value;
}

/** Chart padding used by DataGraph canvas drawing (keep in sync with DataGraph). */
export const DATA_GRAPH_PAD = { left: 52, right: 14, top: 12, bottom: 28 } as const;
