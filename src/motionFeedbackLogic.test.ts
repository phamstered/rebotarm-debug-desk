import { describe, expect, it } from "vitest";
import { parseMotionArrivalErrors } from "./motionFeedbackLogic";
const row = { joint_name: "joint4", target: 0, actual: -.043679, position_error: -.043679, position_tolerance: .02, velocity: -.007326, velocity_tolerance: .03, unit: "rad" };
describe("motion verification diagnostics", () => {
  it("preserves signed position errors and velocity as diagnostic snapshots", () => {
    expect(parseMotionArrivalErrors([row])).toEqual([row]);
    expect(parseMotionArrivalErrors([{ ...row, joint_name: "gripper_finger_left_joint", unit: "m", position_tolerance: .001 }])).toHaveLength(1);
  });
  it("rejects nonfinite, wrong units, duplicate/unknown joints and invalid tolerances", () => {
    for (const value of [undefined, null, [], [row, row], Array(8).fill(row), [{ ...row, joint_name: "unknown" }], [{ ...row, unit: "m" }], [{ ...row, velocity: NaN }], [{ ...row, target: "0" }], [{ ...row, position_tolerance: -1 }]])
      expect(parseMotionArrivalErrors(value)).toBeUndefined();
  });
});
