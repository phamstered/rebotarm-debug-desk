import { describe, expect, it } from "vitest";
import {
  DATA_GRAPH_WINDOW_MS,
  addFieldsToSeries,
  appendSeriesPoint,
  computePlotBounds,
  expandFieldPaths,
  getNumericAtPath,
  listNumericFields,
  parsePathSegments,
  prunePoints,
  removeSeries,
  seriesId,
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
