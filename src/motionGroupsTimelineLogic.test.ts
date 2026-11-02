import { describe, expect, it } from "vitest";
import type { MotionGroup } from "./motionGroupsLogic";
import {
  cloneMotionGroup,
  editorTimeline,
  previewGroupPose,
  reorderGroupStep,
  snappedArrival,
  sourceSnapshotChanged,
} from "./motionGroupsTimelineLogic";
const group = (): MotionGroup => ({
  id: "g",
  name: "pick",
  note: "",
  preparationDuration: 9,
  createdAt: 1,
  updatedAt: 1,
  steps: [
    {
      id: "a",
      positionId: "p",
      positionName: "A",
      positionUpdatedAt: 1,
      positions: [0, 0, 0, 0, 0, 0],
      gripperPosition: 0.01,
      duration: 0,
      hold: 2,
    },
    {
      id: "b",
      positionId: "q",
      positionName: "B",
      positionUpdatedAt: 2,
      positions: [2, 2, 2, 2, 2, 2],
      gripperPosition: 0.03,
      duration: 4,
      hold: 1,
    },
  ],
});
describe("group timeline editing", () => {
  it("keeps preparation outside nominal motion and hold, and interpolates only locally", () => {
    const value = group();
    expect(
      editorTimeline(value).map(({ start, arrival, departure }) => [
        start,
        arrival,
        departure,
      ]),
    ).toEqual([
      [0, 0, 2],
      [2, 6, 7],
    ]);
    expect(previewGroupPose(value, 1)?.positions).toEqual([0, 0, 0, 0, 0, 0]);
    expect(previewGroupPose(value, 4)?.positions).toEqual([1, 1, 1, 1, 1, 1]);
    expect(previewGroupPose(value, 4)?.gripperPosition).toBeCloseTo(0.02);
    expect(previewGroupPose(value, 9)?.positions).toEqual([2, 2, 2, 2, 2, 2]);
    expect(value.preparationDuration).toBe(9);
  });
  it("preserves an unspecified gripper target and rejects nonfinite preview time", () => {
    const value = group();
    delete value.steps[1].gripperPosition;
    expect(previewGroupPose(value, 4)?.gripperPosition).toBe(0.01);
    expect(previewGroupPose(value, 6)?.gripperPosition).toBeUndefined();
    expect(previewGroupPose(value, NaN)).toBeNull();
  });
  it("reorders snapshots without mutating input and restores the zero-duration first frame", () => {
    const value = group(),
      copy = reorderGroupStep(value, 1, 0);
    expect(copy.steps.map((s) => [s.id, s.duration])).toEqual([
      ["b", 0],
      ["a", 5],
    ]);
    copy.steps[0].positions[0] = 99;
    expect(value.steps[1].positions[0]).toBe(2);
    expect(reorderGroupStep(value, -1, 0)).toEqual(value);
  });
  it("snaps arrivals without allowing a zero or negative transition", () => {
    expect(snappedArrival(3.16, 2, true)).toBe(3.2);
    expect(snappedArrival(1, 2, true)).toBe(2.01);
    expect(snappedArrival(3.16, 2, false)).toBe(3.16);
  });
  it("detects changes in source pose, name, gripper and version without changing snapshots", () => {
    const value = group(),
      step = value.steps[0];
    const source = {
      name: step.positionName,
      updatedAt: step.positionUpdatedAt,
      positions: [...step.positions],
      gripperPosition: step.gripperPosition,
    };
    expect(sourceSnapshotChanged(step, source)).toBe(false);
    expect(sourceSnapshotChanged(step, { ...source, updatedAt: 2 })).toBe(true);
    expect(
      sourceSnapshotChanged(step, { ...source, positions: [1, 0, 0, 0, 0, 0] }),
    ).toBe(true);
    const copy = cloneMotionGroup(value);
    copy.steps[0].positions[0] = NaN;
    expect(Number.isNaN(copy.steps[0].positions[0])).toBe(true);
    expect(step.positions[0]).toBe(0);
  });
});

it("does not interpolate one robot track from another robot's joint values", () => {
  const g = group();
  g.steps[0].trackId = "arm"; g.steps[1].trackId = "other";
  expect(previewGroupPose(g, 3, "arm")?.positions).toEqual(g.steps[0].positions);
  expect(previewGroupPose(g, 3, "other")?.positions).toEqual(g.steps[1].positions);
  expect(previewGroupPose(g, 3, "missing")).toBeNull();
});
