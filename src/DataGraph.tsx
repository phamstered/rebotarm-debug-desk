import { useEffect, useRef } from "react";
import type { DataSeries } from "./dataGraphLogic";
import {
  DATA_GRAPH_PAD,
  DATA_GRAPH_WINDOW_MS,
  computePlotBounds,
  nearestValueAtTime,
  plotXFromTimestamp,
  timestampFromPlotX,
} from "./dataGraphLogic";

function formatTick(value: number): string {
  if (Math.abs(value) >= 100 || Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  return value.toFixed(Math.abs(value) >= 10 ? 1 : 2);
}

function formatCrosshairAge(t: number, now: number): string {
  const ageSec = (now - t) / 1000;
  if (ageSec <= 0.05) return "now";
  return `-${ageSec.toFixed(1)}s`;
}

function drawChart(
  canvas: HTMLCanvasElement,
  seriesList: DataSeries[],
  now: number,
  crosshairT: number | null,
) {
  const parent = canvas.parentElement;
  const width = Math.max(parent?.clientWidth ?? canvas.clientWidth, 120);
  const height = Math.max(parent?.clientHeight ?? canvas.clientHeight, 120);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const pad = DATA_GRAPH_PAD;
  const plotW = Math.max(width - pad.left - pad.right, 1);
  const plotH = Math.max(height - pad.top - pad.bottom, 1);
  const bounds = computePlotBounds(seriesList, now);
  const spanT = Math.max(bounds.maxT - bounds.minT, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9);

  const xOf = (t: number) => pad.left + ((t - bounds.minT) / spanT) * plotW;
  const yOf = (v: number) => pad.top + (1 - (v - bounds.minY) / spanY) * plotH;

  ctx.fillStyle = "#07131c";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#1b3443";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();
    const value = bounds.maxY - (spanY * i) / 4;
    ctx.fillStyle = "#668496";
    ctx.font = "10px SFMono-Regular, monospace";
    ctx.textAlign = "right";
    ctx.fillText(formatTick(value), pad.left - 6, y + 3);
  }
  for (let i = 0; i <= 3; i += 1) {
    const x = pad.left + (plotW * i) / 3;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    const age = ((3 - i) / 3) * (DATA_GRAPH_WINDOW_MS / 1000);
    ctx.fillStyle = "#668496";
    ctx.textAlign = "center";
    ctx.fillText(i === 3 ? "now" : `-${age.toFixed(0)}s`, x, height - 8);
  }

  ctx.strokeStyle = "#31536a";
  ctx.strokeRect(pad.left, pad.top, plotW, plotH);

  for (const series of seriesList) {
    const visible = series.points.filter((point) => point.t >= bounds.minT && point.t <= bounds.maxT);
    if (visible.length === 0) continue;
    ctx.beginPath();
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.5;
    visible.forEach((point, index) => {
      const x = xOf(point.t);
      const y = yOf(point.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (crosshairT != null && crosshairT >= bounds.minT && crosshairT <= bounds.maxT) {
    const x = plotXFromTimestamp(crosshairT, pad.left, plotW, bounds.minT, bounds.maxT);
    ctx.strokeStyle = "rgba(226, 255, 248, 0.85)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const readoutParts: string[] = [formatCrosshairAge(crosshairT, now)];
    for (const series of seriesList) {
      const value = nearestValueAtTime(series.points, crosshairT);
      if (value !== undefined) {
        readoutParts.push(`${series.fieldPath}=${formatTick(value)}`);
      }
    }
    const label = readoutParts.join(" · ");
    ctx.font = "10px SFMono-Regular, monospace";
    const labelWidth = Math.min(ctx.measureText(label).width + 10, plotW);
    const labelX = Math.min(Math.max(x - labelWidth / 2, pad.left), pad.left + plotW - labelWidth);
    ctx.fillStyle = "rgba(8, 20, 28, 0.88)";
    ctx.fillRect(labelX, pad.top + 2, labelWidth, 16);
    ctx.fillStyle = "#d6f6ef";
    ctx.textAlign = "left";
    ctx.fillText(label, labelX + 5, pad.top + 13, labelWidth - 8);
  }
}

export function DataGraph({
  seriesList,
  liveUpdates,
  onRemoveSeries,
  onClearSeries,
  emptyHint = "在右侧 Inspector 选择数值字段并「加入 Monitor」",
  compact = false,
  title,
  crosshairT = null,
  onCrosshairChange,
  viewNow = null,
}: {
  seriesList: DataSeries[];
  liveUpdates: boolean;
  onRemoveSeries(id: string): void;
  onClearSeries(): void;
  emptyHint?: string;
  compact?: boolean;
  title?: string;
  /** Shared crosshair timestamp (ms, performance clock); null hides the cursor. */
  crosshairT?: number | null;
  onCrosshairChange?(t: number | null): void;
  /**
   * Explicit window end time (ms). Used for paused follow and bag `/clock` timelines.
   * When null, charts slide with performance.now() (live wall clock).
   */
  viewNow?: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seriesRef = useRef(seriesList);
  const crosshairRef = useRef(crosshairT);
  const liveRef = useRef(liveUpdates);
  const viewNowRef = useRef(viewNow);
  seriesRef.current = seriesList;
  crosshairRef.current = crosshairT;
  liveRef.current = liveUpdates;
  viewNowRef.current = viewNow;

  const resolveNow = () => {
    if (viewNowRef.current != null) return viewNowRef.current;
    return performance.now();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const paint = () => {
      drawChart(canvas, seriesRef.current, resolveNow(), crosshairRef.current);
    };
    paint();
    const onResize = () => paint();
    window.addEventListener("resize", onResize);
    // When following live, slide the window; when paused, keep redrawing frozen view / crosshair.
    frame = window.setInterval(paint, 200);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearInterval(frame);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawChart(canvas, seriesList, resolveNow(), crosshairT);
  }, [seriesList, crosshairT, liveUpdates, viewNow]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !onCrosshairChange) return;

    const toLocalX = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return event.clientX - rect.left;
    };

    const onMove = (event: PointerEvent) => {
      const width = Math.max(canvas.parentElement?.clientWidth ?? canvas.clientWidth, 120);
      const pad = DATA_GRAPH_PAD;
      const plotW = Math.max(width - pad.left - pad.right, 1);
      const x = toLocalX(event);
      if (x < pad.left || x > pad.left + plotW) {
        onCrosshairChange(null);
        return;
      }
      const now = resolveNow();
      const bounds = computePlotBounds(seriesRef.current, now);
      onCrosshairChange(timestampFromPlotX(x, pad.left, plotW, bounds.minT, bounds.maxT));
    };

    const onLeave = () => onCrosshairChange(null);

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [onCrosshairChange]);

  const topic = seriesList[0]?.topic;

  const heading = title ?? (seriesList[0]?.fieldPath || "DataGraph");
  const followLabel = liveUpdates ? "" : " · 已暂停";

  return (
    <div className={`data-graph-view${compact ? " compact" : ""}`}>
      <div className="graph-toolbar data-graph-toolbar">
        <span>
          {compact
            ? `${heading}${followLabel}`
            : seriesList.length === 0
              ? "从 Inspector 添加数值字段 · 默认窗口 30s"
              : `${topic} · ${seriesList.length} 条曲线 · 窗口 ${DATA_GRAPH_WINDOW_MS / 1000}s${followLabel}`}
        </span>
        {compact ? (
          seriesList[0] ? (
            <button
              type="button"
              className="data-graph-remove"
              onClick={() => onRemoveSeries(seriesList[0]!.id)}
              aria-label={`移除 ${seriesList[0]!.fieldPath}`}
            >
              ×
            </button>
          ) : null
        ) : (
          <button type="button" onClick={onClearSeries} disabled={seriesList.length === 0}>清空曲线</button>
        )}
      </div>
      <div className="data-graph-body">
        <div className="data-graph-canvas-wrap">
          {seriesList.length === 0 && (
            <div className="graph-empty">{emptyHint}</div>
          )}
          <canvas ref={canvasRef} className="data-graph-canvas" aria-label={compact ? `${heading} 曲线` : "DataGraph 实时曲线"} />
        </div>
        {!compact && seriesList.length > 0 && (
          <ul className="data-graph-legend" aria-label="DataGraph 曲线列表">
            {seriesList.map((series) => (
              <li key={series.id}>
                <span className="data-graph-swatch" style={{ background: series.color }} />
                <span className="data-graph-legend-label" title={series.label}>{series.fieldPath}</span>
                <button type="button" className="data-graph-remove" onClick={() => onRemoveSeries(series.id)} aria-label={`移除 ${series.fieldPath}`}>×</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
