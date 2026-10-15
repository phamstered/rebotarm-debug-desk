import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MonitorChart } from "./MonitorChart";
import { createTorqueDashboard, panelSeries } from "./monitorLogic";

describe("MonitorChart", () => {
  const props = { liveUpdates: true, crosshairT: null, onCrosshairChange: vi.fn(), viewNow: null, onChartChange: vi.fn() };
  const panelWithValues = () => {
    const panel = createTorqueDashboard("/js", 1).panels[0]!;
    panel.series.points = [{ t: 1, value: 40 }];
    return panel;
  };

  it("renders line, points, and bars on the time-series canvas", () => {
    const panel = panelWithValues();
    for (const timeStyle of ["line", "points", "bars"] as const) {
      panel.chart.timeStyle = timeStyle;
      const { unmount } = render(<MonitorChart panel={panel} {...props} />);
      expect(screen.getByLabelText("effort[0] 曲线")).toBeVisible();
      unmount();
    }
    expect(panelSeries(panel)).toHaveLength(1);
  });

  it("shows current values as bars, pie proportions, and gauges", () => {
    const panel = panelWithValues();
    panel.chart.type = "bar";
    const { rerender } = render(<MonitorChart panel={panel} {...props} />);
    expect(screen.getByLabelText("effort[0] 条形图")).toHaveTextContent("40");
    panel.chart = { ...panel.chart, type: "pie" };
    rerender(<MonitorChart panel={panel} {...props} />);
    expect(screen.getByLabelText("effort[0] 环形图")).toHaveTextContent("100.0%");
    panel.chart = { ...panel.chart, type: "gauge" };
    rerender(<MonitorChart panel={panel} {...props} />);
    expect(screen.getByLabelText("effort[0] 仪表盘")).toHaveTextContent("40");
    expect(screen.getByLabelText("effort[0] 阈值")).toHaveValue(80);
    const minimum = screen.getByLabelText("effort[0] 最小值");
    fireEvent.change(minimum, { target: { value: "-10" } });
    fireEvent.blur(minimum);
    expect(props.onChartChange).toHaveBeenCalledWith({ gaugeMin: -10 });
  });
});
