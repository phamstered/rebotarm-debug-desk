import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataGraph } from "./DataGraph";
import type { DataSeries } from "./dataGraphLogic";

const series: DataSeries[] = [
  {
    id: "/js::effort[0]",
    topic: "/js",
    fieldPath: "effort[0]",
    label: "/js · effort[0]",
    color: "#42d6c7",
    points: [{ t: 1, value: 10 }],
  },
];

describe("DataGraph", () => {
  it("shows empty guidance and disables clear", () => {
    render(<DataGraph seriesList={[]} liveUpdates onRemoveSeries={() => undefined} onClearSeries={() => undefined} />);
    expect(screen.getByText(/从 Inspector 添加数值字段/)).toBeVisible();
    expect(screen.getByRole("button", { name: "清空曲线" })).toBeDisabled();
    expect(screen.getByLabelText("DataGraph 实时曲线")).toBeInTheDocument();
  });

  it("lists series and supports remove / clear", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(<DataGraph seriesList={series} liveUpdates onRemoveSeries={onRemove} onClearSeries={onClear} />);
    expect(screen.getByText(/1 条曲线/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移除 effort[0]" }));
    expect(onRemove).toHaveBeenCalledWith("/js::effort[0]");
    await user.click(screen.getByRole("button", { name: "清空曲线" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("renders a custom empty hint and paused window label", () => {
    const { rerender } = render(
      <DataGraph
        seriesList={[]}
        liveUpdates
        emptyHint="自定义空提示"
        onRemoveSeries={() => undefined}
        onClearSeries={() => undefined}
      />,
    );
    expect(screen.getByText("自定义空提示")).toBeVisible();

    rerender(
      <DataGraph
        seriesList={series}
        liveUpdates={false}
        onRemoveSeries={() => undefined}
        onClearSeries={() => undefined}
      />,
    );
    expect(screen.getByText(/已暂停/)).toBeVisible();
    expect(screen.getByText(/窗口 30s/)).toBeVisible();
  });

  it("leaves compact Panel controls to the outer header and gives the plot the full body", () => {
    render(
      <DataGraph
        seriesList={series}
        liveUpdates
        compact
        title="effort[0]"
        onRemoveSeries={() => undefined}
        onClearSeries={() => undefined}
      />,
    );
    const canvas = screen.getByLabelText("effort[0] 曲线");
    expect(canvas).toBeVisible();
    expect(canvas.closest(".data-graph-view")).toHaveClass("compact");
    expect(screen.queryByText("effort[0]")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除 effort[0]" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("DataGraph 曲线列表")).not.toBeInTheDocument();
  });

  it("reports crosshair timestamps from pointer moves over the plot", () => {
    const onCrosshairChange = vi.fn();
    render(
      <DataGraph
        seriesList={series}
        liveUpdates={false}
        viewNow={30_000}
        crosshairT={null}
        onCrosshairChange={onCrosshairChange}
        onRemoveSeries={() => undefined}
        onClearSeries={() => undefined}
      />,
    );
    const canvas = screen.getByLabelText("DataGraph 实时曲线");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }),
    });
    Object.defineProperty(canvas.parentElement!, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(canvas.parentElement!, "clientHeight", { value: 200, configurable: true });

    fireEvent.pointerMove(canvas, { clientX: 202, clientY: 80 });
    expect(onCrosshairChange).toHaveBeenCalled();
    const t = onCrosshairChange.mock.calls.at(-1)![0] as number;
    expect(typeof t).toBe("number");
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThanOrEqual(30_000);

    fireEvent.pointerLeave(canvas);
    expect(onCrosshairChange).toHaveBeenLastCalledWith(null);
  });
});
