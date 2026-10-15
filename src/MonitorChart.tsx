import { useEffect, useState } from "react";
import { DataGraph } from "./DataGraph";
import { gaugeFraction, latestSeriesValues, pieSlices } from "./monitorChartLogic";
import type { MonitorPanel } from "./monitorLogic";
import { panelSeries } from "./monitorLogic";

function formatValue(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
}

function GaugeSettingInput({ label, title, value, onCommit }: { label: string; title: string; value: number; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label>{label} <input type="number" value={draft} aria-label={`${title} ${label}`} onChange={(event) => setDraft(event.target.value)}
    onBlur={() => {
      const parsed = Number(draft);
      if (draft.trim() && Number.isFinite(parsed)) onCommit(parsed);
      else setDraft(String(value));
    }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
  /></label>;
}

export function MonitorChart({ panel, liveUpdates, crosshairT, onCrosshairChange, viewNow, onChartChange }: {
  panel: MonitorPanel;
  liveUpdates: boolean;
  crosshairT: number | null;
  onCrosshairChange(t: number | null): void;
  viewNow: number | null;
  onChartChange(chart: Partial<MonitorPanel["chart"]>): void;
}) {
  const seriesList = panelSeries(panel);
  const values = latestSeriesValues(seriesList);
  const chart = panel.chart;
  if (chart.type === "time-series") return <div className="monitor-chart-content">
    <DataGraph
      seriesList={seriesList} liveUpdates={liveUpdates} compact title={panel.title}
      emptyHint="等待数据" crosshairT={crosshairT} onCrosshairChange={onCrosshairChange}
      viewNow={viewNow} renderStyle={chart.timeStyle}
      onRemoveSeries={() => undefined} onClearSeries={() => undefined}
    />
    {seriesList.length > 1 && <div className="monitor-chart-series-key" aria-label="Panel 数据序列">
      {seriesList.map((series) => <span key={series.id} title={series.label}><i style={{ background: series.color }} />{series.fieldPath}</span>)}
    </div>}
  </div>;

  if (chart.type === "pie") {
    const slices = pieSlices(values);
    let offset = 0;
    const gradient = slices.map((slice) => {
      const start = offset;
      offset += slice.percent;
      return `${slice.color} ${start}% ${offset}%`;
    }).join(", ");
    return <div className="monitor-chart-content monitor-snapshot-chart" aria-label={`${panel.title} 环形图`}>
      {slices.length ? <div className="monitor-pie-layout">
        <div className="monitor-pie-ring" style={{ background: `conic-gradient(${gradient})` }} aria-label="正值占比" />
        <ul className="monitor-value-list">{slices.map((slice) => <li key={slice.id}><i style={{ background: slice.color }} /><span title={slice.label}>{slice.label}</span><strong>{slice.percent.toFixed(1)}%</strong></li>)}</ul>
      </div> : <div className="monitor-chart-no-data">等待正值数据</div>}
    </div>;
  }

  if (chart.type === "bar") {
    const scale = Math.max(...values.map((entry) => Math.abs(entry.value)), 1e-9);
    return <div className={`monitor-chart-content monitor-snapshot-chart monitor-bars ${chart.barOrientation}`} aria-label={`${panel.title} 条形图`}>
      {values.length ? values.map((entry) => <div className="monitor-bar-entry" key={entry.id} title={`${entry.label}: ${formatValue(entry.value)}`}>
        <span className="monitor-bar-label">{entry.label}</span>
        <span className="monitor-bar-track"><i style={{ background: entry.color, [chart.barOrientation === "vertical" ? "height" : "width"]: `${Math.max(2, Math.abs(entry.value) / scale * 100)}%` }} /></span>
        <strong>{formatValue(entry.value)}</strong>
      </div>) : <div className="monitor-chart-no-data">等待数据</div>}
    </div>;
  }

  return <div className="monitor-chart-content monitor-snapshot-chart" aria-label={`${panel.title} 仪表盘`}>
    <div className="monitor-gauge-settings">
      <GaugeSettingInput label="最小值" title={panel.title} value={chart.gaugeMin} onCommit={(gaugeMin) => onChartChange({ gaugeMin })} />
      <GaugeSettingInput label="最大值" title={panel.title} value={chart.gaugeMax} onCommit={(gaugeMax) => onChartChange({ gaugeMax })} />
      <GaugeSettingInput label="阈值" title={panel.title} value={chart.gaugeThreshold} onCommit={(gaugeThreshold) => onChartChange({ gaugeThreshold })} />
    </div>
    {values.length ? <div className="monitor-gauge-list">{values.map((entry) => {
      const fraction = gaugeFraction(entry.value, chart.gaugeMin, chart.gaugeMax);
      const color = entry.value >= chart.gaugeThreshold ? "#f4ad5d" : entry.color;
      return <div className="monitor-gauge" key={entry.id}>
        <div className="monitor-gauge-ring" style={{ background: `conic-gradient(${color} ${fraction * 100}%, #1b3443 ${fraction * 100}% 100%)` }}><strong>{formatValue(entry.value)}</strong></div>
        <span title={entry.label}>{entry.label}</span>
      </div>;
    })}</div> : <div className="monitor-chart-no-data">等待数据</div>}
  </div>;
}
