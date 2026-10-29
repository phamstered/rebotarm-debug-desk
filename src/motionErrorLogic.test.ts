import { describe, expect, it } from "vitest";
import { jointExecutionError, tcpExecutionError } from "./motionErrorLogic";

describe("motion execution error", () => {
  it("compares the commanded joints with the settled feedback", () => {
    const error = jointExecutionError(
      ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
      [0, 0, 0, 0, 0, 0],
      ["joint6", "joint1", "joint2", "joint3", "joint4", "joint5"],
      [0.01, 0.02, 0, 0, 0, -0.03],
    );
    if ("error" in error) throw new Error(error.error);
    expect(error.perJoint.map((item) => item.delta)).toEqual([0.02, 0, 0, 0, -0.03, 0.01]);
    expect(error.maxAbsRad).toBeCloseTo(0.03);
  });

  it("refuses an incomplete settled sample", () => {
    const missing = jointExecutionError(["joint1"], [0], ["joint1"], []);
    expect("error" in missing && missing.error).toMatch(/反馈/);
  });

  it("reports TCP distance in millimetres and orientation in degrees", () => {
    const error = tcpExecutionError(
      [0, 0, 0],
      [0, 0, 0, 1],
      [0.001, 0, 0],
      [0, 0, 0, 1],
    );
    expect(error.positionMm).toBeCloseTo(1);
    expect(error.orientationDeg).toBeCloseTo(0);
  });
});
