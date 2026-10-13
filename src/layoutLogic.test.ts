import { describe, expect, it } from "vitest";
import {
  defaultLayoutSizes,
  loadLayoutSizes,
  normalizeLayoutSizes,
  resizeColumn,
  resizeSplit,
} from "./layoutLogic";

const storage = (value: string | null) => ({ getItem: () => value });

describe("resizable workspace layout", () => {
  it("loads defaults and safely normalizes persisted values", () => {
    expect(loadLayoutSizes(storage(null))).toEqual(defaultLayoutSizes);
    expect(loadLayoutSizes(storage("bad"))).toEqual(defaultLayoutSizes);
    expect(normalizeLayoutSizes({ leftWidth: 999, rightWidth: 10, leftTopRatio: -1 })).toEqual({
      leftWidth: 480,
      rightWidth: 260,
      leftTopRatio: 0.18,
    });
  });

  it("resizes both side columns while preserving room for the center view", () => {
    expect(resizeColumn("left", 420, 1440, defaultLayoutSizes).leftWidth).toBe(420);
    expect(resizeColumn("right", 1000, 1440, defaultLayoutSizes).rightWidth).toBe(440);
    expect(resizeColumn("left", 900, 1200, defaultLayoutSizes).leftWidth).toBe(450);
  });

  it("turns a pointer position into a bounded vertical split ratio", () => {
    expect(resizeSplit(400, 100, 600)).toBe(0.5);
    expect(resizeSplit(100, 100, 600)).toBe(0.18);
    expect(resizeSplit(1000, 100, 600)).toBe(0.82);
    expect(resizeSplit(100, 0, 0)).toBe(0.5);
  });
});
