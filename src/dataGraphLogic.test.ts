import { describe, expect, it } from "vitest";
import {
  DATA_GRAPH_MAX_POINTS,
  DATA_GRAPH_WINDOW_MS,
  addFieldsToSeries,
  appendSeriesPoint,
  computePlotBounds,
  createSeries,
  expandFieldPaths,
  getNumericAtPath,
  listNumericFields,
  nextSeriesColor,
  parsePathSegments,
  nearestValueAtTime,
  plotXFromTimestamp,
  prunePoints,
  removeSeries,
  seriesId,
  timestampFromPlotX,
  updateSeriesFromMessage,
} from "./dataGraphLogic";

const jointState = {
  name: ["j1", "j2", "j3"],
  position: [0.1, 0.2, 0.3],
  velocity: [1, 2, 3],
  effort: [10, 20, 30, 40, 50, 60, 70],
  header: { stamp: { sec: 1, nanosec: 2 }, frame_id: "base" },
};

describe("dataGraphLogic path extraction", () => {
  it("parses dotted and indexed path segments", () => {
    expect(parsePathSegments("effort[0]")).toEqual([{ key: "effort", index: 0 }]);
    expect(parsePathSegments("header.stamp.sec")).toEqual([
      { key: "header" },
      { key: "stamp" },
      { key: "sec" },
    ]);
    expect(parsePathSegments("foo.bar[2]")).toEqual([
      { key: "foo" },
      { key: "bar", index: 2 },
    ]);
  });

  it("reads scalar and indexed numeric leaves", () => {
    expect(getNumericAtPath(jointState, "effort[0]")).toBe(10);
    expect(getNumericAtPath(jointState, "effort[6]")).toBe(70);
    expect(getNumericAtPath(jointState, "header.stamp.sec")).toBe(1);
    expect(getNumericAtPath(jointState, "effort[99]")).toBeUndefined();
    expect(getNumericAtPath(jointState, "name[0]")).toBeUndefined();
  });

  it("lists numeric scalars and finite number arrays", () => {
    const fields = listNumericFields(jointState);
    expect(fields).toEqual(expect.arrayContaining([
      { path: "position", kind: "array", length: 3 },
      { path: "velocity", kind: "array", length: 3 },
      { path: "effort", kind: "array", length: 7 },
      { path: "header.stamp.sec", kind: "scalar" },
      { path: "header.stamp.nanosec", kind: "scalar" },
    ]));
    expect(fields.find((field) => field.path === "name")).toBeUndefined();
  });

  it("expands array fields to per-index paths", () => {
    expect(expandFieldPaths("effort", jointState)).toEqual([
      "effort[0]", "effort[1]", "effort[2]", "effort[3]", "effort[4]", "effort[5]", "effort[6]",
    ]);
    expect(expandFieldPaths("header.stamp.sec", jointState)).toEqual(["header.stamp.sec"]);
    expect(expandFieldPaths("missing", jointState)).toEqual([]);
  });
});

describe("dataGraphLogic series updates", () => {
  it("appends points and prunes outside the sliding window", () => {
    const series = {
      id: seriesId("/js", "effort[0]"),
      topic: "/js",
      fieldPath: "effort[0]",
      label: "/js · effort[0]",
      color: "#42d6c7",
      points: [{ t: 1_000, value: 1 }],
    };
    const next = appendSeriesPoint(series, 1_000 + DATA_GRAPH_WINDOW_MS + 5_000, 2);
    expect(next.points).toEqual([{ t: 1_000 + DATA_GRAPH_WINDOW_MS + 5_000, value: 2 }]);
  });

  it("updates matching topic series from a message", () => {
    let list = addFieldsToSeries([], "/stm32/joint_states", "effort", jointState, 100);
    expect(list).toHaveLength(7);
    expect(list[0]?.points).toEqual([{ t: 100, value: 10 }]);

    list = updateSeriesFromMessage(list, "/stm32/joint_states", { ...jointState, effort: [11, 21, 31, 41, 51, 61, 71] }, 200);
    expect(list[0]?.points).toEqual([
      { t: 100, value: 10 },
      { t: 200, value: 11 },
    ]);
    expect(list[6]?.points.at(-1)).toEqual({ t: 200, value: 71 });
  });

  it("ignores other topics when updating and still prunes by time", () => {
    const list = addFieldsToSeries([], "/a", "effort", jointState, 0);
    const unchanged = updateSeriesFromMessage(list, "/b", jointState, 10);
    expect(unchanged).toBe(list);

    const pruned = updateSeriesFromMessage(list, "/b", jointState, DATA_GRAPH_WINDOW_MS + 1);
    expect(pruned[0]?.points).toEqual([]);
  });

  it("enforces single-topic by replacing series from another topic", () => {
    const first = addFieldsToSeries([], "/a", "effort[0]", jointState, 1);
    const second = addFieldsToSeries(first, "/b", "position[0]", jointState, 2);
    expect(second).toHaveLength(1);
    expect(second[0]?.topic).toBe("/b");
    expect(second[0]?.fieldPath).toBe("position[0]");
  });

  it("skips duplicate field paths and supports remove", () => {
    const once = addFieldsToSeries([], "/js", "effort[0]", jointState, 1);
    const twice = addFieldsToSeries(once, "/js", "effort[0]", jointState, 2);
    expect(twice).toHaveLength(1);
    expect(removeSeries(twice, twice[0]!.id)).toEqual([]);
  });

  it("prunes points and computes plot bounds", () => {
    expect(prunePoints([{ t: 0, value: 1 }, { t: 100, value: 2 }], 100 + DATA_GRAPH_WINDOW_MS, DATA_GRAPH_WINDOW_MS))
      .toEqual([{ t: 100, value: 2 }]);
    const list = addFieldsToSeries([], "/js", "effort[0]", jointState, 1_000);
    const bounds = computePlotBounds(list, 1_000);
    expect(bounds.minT).toBe(1_000 - DATA_GRAPH_WINDOW_MS);
    expect(bounds.maxT).toBe(1_000);
    expect(bounds.minY).toBeLessThan(10);
    expect(bounds.maxY).toBeGreaterThan(10);
  });
});

describe("dataGraphLogic edge cases", () => {
  it("rejects non-finite numbers and skips image payload keys", () => {
    expect(getNumericAtPath({ x: Number.NaN }, "x")).toBeUndefined();
    expect(getNumericAtPath({ x: Number.POSITIVE_INFINITY }, "x")).toBeUndefined();
    expect(parsePathSegments("")).toEqual([]);
    expect(listNumericFields({
      data_base64: "abc",
      data_length: 3,
      width: 2,
      nested: { ok: 1, bad: Number.NaN },
    })).toEqual([
      { path: "width", kind: "scalar" },
      { path: "nested.ok", kind: "scalar" },
    ]);
  });

  it("walks nested object arrays and returns empty for blank roots", () => {
    expect(listNumericFields(null)).toEqual([]);
    expect(listNumericFields(42)).toEqual([]);
    expect(listNumericFields([{ a: 1 }, { a: 2 }])).toEqual([
      { path: "[0].a", kind: "scalar" },
      { path: "[1].a", kind: "scalar" },
    ]);
    expect(listNumericFields([])).toEqual([]);
  });

  it("keeps already-indexed paths and expands only finite numeric arrays", () => {
    expect(expandFieldPaths("effort[2]", jointState)).toEqual(["effort[2]"]);
    expect(expandFieldPaths("name", jointState)).toEqual([]);
    expect(expandFieldPaths("position", { position: [] })).toEqual([]);
  });

  it("caps the ring buffer at DATA_GRAPH_MAX_POINTS inside the window", () => {
    let series = {
      id: seriesId("/js", "effort[0]"),
      topic: "/js",
      fieldPath: "effort[0]",
      label: "/js · effort[0]",
      color: "#42d6c7",
      points: [] as { t: number; value: number }[],
    };
    const start = 1_000_000;
    for (let i = 0; i < DATA_GRAPH_MAX_POINTS + 50; i += 1) {
      series = appendSeriesPoint(series, start + i, i);
    }
    expect(series.points.length).toBe(DATA_GRAPH_MAX_POINTS);
    expect(series.points[0]?.t).toBe(start + 50);
    expect(series.points.at(-1)?.value).toBe(DATA_GRAPH_MAX_POINTS + 49);
  });

  it("prunes matching-topic series when the field is missing", () => {
    const list = addFieldsToSeries([], "/js", "effort[0]", jointState, 0);
    const pruned = updateSeriesFromMessage(list, "/js", { position: [1] }, DATA_GRAPH_WINDOW_MS + 10);
    expect(pruned[0]?.points).toEqual([]);
  });

  it("pads equal and empty Y bounds for plotting", () => {
    const flat = addFieldsToSeries([], "/js", "effort[0]", { effort: [5, 5, 5] }, 1_000);
    const equal = computePlotBounds(flat, 1_000);
    expect(equal.minY).toBeLessThan(5);
    expect(equal.maxY).toBeGreaterThan(5);

    const empty = computePlotBounds([], 500);
    expect(empty).toEqual({
      minT: 500 - DATA_GRAPH_WINDOW_MS,
      maxT: 500,
      minY: -1,
      maxY: 1,
    });
  });

  it("cycles series colors and creates labeled series", () => {
    expect(nextSeriesColor(0)).toBe("#42d6c7");
    expect(nextSeriesColor(10)).toBe(nextSeriesColor(0));
    const created = createSeries("/t", "v", 1, { t: 3, value: 9 });
    expect(created).toMatchObject({
      id: "/t::v",
      label: "/t · v",
      color: nextSeriesColor(1),
      points: [{ t: 3, value: 9 }],
    });
  });
});

describe("dataGraphLogic crosshair mapping", () => {
  it("maps plot x to timestamp and back within the window", () => {
    const minT = 1000;
    const maxT = 4000;
    expect(timestampFromPlotX(52, 52, 300, minT, maxT)).toBe(minT);
    expect(timestampFromPlotX(52 + 300, 52, 300, minT, maxT)).toBe(maxT);
    expect(timestampFromPlotX(52 + 150, 52, 300, minT, maxT)).toBe(2500);
    expect(plotXFromTimestamp(2500, 52, 300, minT, maxT)).toBe(202);
    expect(timestampFromPlotX(-10, 52, 300, minT, maxT)).toBe(minT);
  });

  it("reads the nearest sample at or before the crosshair time", () => {
    const points = [
      { t: 100, value: 1 },
      { t: 200, value: 2 },
      { t: 300, value: 3 },
    ];
    expect(nearestValueAtTime(points, 250)).toBe(2);
    expect(nearestValueAtTime(points, 300)).toBe(3);
    expect(nearestValueAtTime(points, 50)).toBeUndefined();
    expect(nearestValueAtTime([], 100)).toBeUndefined();
  });
});

