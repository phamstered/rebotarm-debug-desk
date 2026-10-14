import { useEffect, useRef } from "react";
import type { DataSeries } from "./dataGraphLogic";
import { DATA_GRAPH_WINDOW_MS, computePlotBounds } from "./dataGraphLogic";

function formatTick(value: number): string {
  if (Math.abs(value) >= 100 || Math.abs(value) < 0.01 && value !== 0) return value.toExponential(1);
  return value.toFixed(Math.abs(value) >= 10 ? 1 : 2);
}

function drawChart(
  canvas: HTMLCanvasElement,
  seriesList: DataSeries[],
  now: number,
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

  const pad = { left: 52, right: 14, top: 12, bottom: 28 };
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
}

export function DataGraph({
  seriesList,
  liveUpdates,
  onRemoveSeries,
  onClearSeries,
}: {
  seriesList: DataSeries[];
  liveUpdates: boolean;
  onRemoveSeries(id: string): void;
  onClearSeries(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seriesRef = useRef(seriesList);
  seriesRef.current = seriesList;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const paint = () => {
      drawChart(canvas, seriesRef.current, performance.now());
    };
    paint();
    const onResize = () => paint();
    window.addEventListener("resize", onResize);
    // Keep the time axis sliding even when paused (frozen samples) or idle.
    frame = window.setInterval(paint, 200);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearInterval(frame);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) drawChart(canvas, seriesList, performance.now());
  }, [seriesList]);

  const topic = seriesList[0]?.topic;

  return (
    <div className="data-graph-view">
      <div className="graph-toolbar data-graph-toolbar">
        <span>
          {seriesList.length === 0
            ? "从 Topic Inspector 添加数值字段 · 默认窗口 30s"
            : `${topic} · ${seriesList.length} 条曲线 · 窗口 ${DATA_GRAPH_WINDOW_MS / 1000}s${liveUpdates ? "" : " · 已暂停"}`}
        </span>
        <button type="button" onClick={onClearSeries} disabled={seriesList.length === 0}>清空曲线</button>
      </div>
      <div className="data-graph-body">
        <div className="data-graph-canvas-wrap">
          {seriesList.length === 0 && (
            <div className="graph-empty">在右侧 Topic Inspector 选择数值字段并「加入 DataGraph」</div>
          )}
          <canvas ref={canvasRef} className="data-graph-canvas" aria-label="DataGraph 实时曲线" />
        </div>
        {seriesList.length > 0 && (
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
