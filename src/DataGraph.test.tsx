import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText(/从 Topic Inspector 添加数值字段/)).toBeVisible();
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
});
