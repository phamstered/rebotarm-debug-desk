import { describe, expect, it } from "vitest";
import { boundedMotionSize, defaultMotionLayout, loadMotionLayout } from "./motionLayoutLogic";

describe("Motion layout preferences", () => {
  it("recovers malformed, null, arrays and inaccessible storage", () => {
    for (const value of [null, "bad", "null", "[]", "12"]) expect(loadMotionLayout({ getItem: () => value })).toEqual(defaultMotionLayout);
    expect(loadMotionLayout({ getItem: () => { throw Error("denied"); } })).toEqual(defaultMotionLayout);
  });
  it("restores each size independently and clamps corrupt preferences", () => {
    expect(loadMotionLayout({ getItem: () => JSON.stringify({ controllersWidth: 400, controlsWidth: 1, logHeight: 99999, toolsHeight: "400", statusWidth: null }) }))
      .toEqual({ ...defaultMotionLayout, controllersWidth: 400, controlsWidth: 220, logHeight: 600 });
    expect(boundedMotionSize("rgbdHeight", NaN)).toBe(defaultMotionLayout.rgbdHeight);
    expect(boundedMotionSize("controllersWidth", 500, 320)).toBe(320);
  });
});
