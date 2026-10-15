import type { DataSeries } from "./dataGraphLogic";

export type LatestSeriesValue = { id: string; label: string; color: string; value: number };

/** Snapshot charts use the newest finite sample from each field. */
export function latestSeriesValues(seriesList: DataSeries[]): LatestSeriesValue[] {
  return seriesList.flatMap((series) => {
    let point: (typeof series.points)[number] | undefined;
    for (let index = series.points.length - 1; index >= 0; index -= 1) {
      if (Number.isFinite(series.points[index]!.value)) { point = series.points[index]; break; }
    }
    return point ? [{ id: series.id, label: series.fieldPath, color: series.color, value: point.value }] : [];
  });
}

/** Pie slices represent nonnegative parts of a whole; zero/negative fields are omitted. */
export function pieSlices(values: LatestSeriesValue[]): Array<LatestSeriesValue & { percent: number }> {
  const positive = values.filter((entry) => entry.value > 0);
  const total = positive.reduce((sum, entry) => sum + entry.value, 0);
  return total > 0 && Number.isFinite(total) ? positive.map((entry) => ({ ...entry, percent: entry.value / total * 100 })) : [];
}

export function gaugeFraction(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}
