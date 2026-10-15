import { describe, expect, it } from "vitest";
import { createSeries } from "./dataGraphLogic";
import { gaugeFraction, latestSeriesValues, pieSlices } from "./monitorChartLogic";

describe("Monitor snapshot charts", () => {
  it("uses each field's latest finite sample and excludes nonpositive pie values", () => {
    const a = createSeries("/topic", "a", 0);
    const b = createSeries("/topic", "b", 1);
    const c = createSeries("/topic", "c", 2);
    a.points = [{ t: 1, value: 2 }, { t: 2, value: 4 }];
    b.points = [{ t: 1, value: -2 }];
    c.points = [{ t: 1, value: Number.NaN }];
    const values = latestSeriesValues([a, b, c]);
    expect(values.map(({ value }) => value)).toEqual([4, -2]);
    expect(pieSlices(values)).toMatchObject([{ label: "a", percent: 100 }]);
    expect(pieSlices(values.filter((entry) => entry.value < 0))).toEqual([]);
  });

  it("clamps gauge fill to the configured range", () => {
    expect(gaugeFraction(-20, 0, 100)).toBe(0);
    expect(gaugeFraction(50, 0, 100)).toBe(0.5);
    expect(gaugeFraction(200, 0, 100)).toBe(1);
    expect(gaugeFraction(5, 10, 10)).toBe(0);
  });
});
