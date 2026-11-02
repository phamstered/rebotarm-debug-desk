import { describe, expect, it } from "vitest";
import { parseMotionArrivalErrors, parseMotionHoldFailure } from "./motionFeedbackLogic";
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

describe("hold failure trigger snapshots", () => {
  const trigger = { reason: "position_drift", phase: "paused", captured_at_ms: 1793613261062,
    feedback_age_ms: 4, samples: [row], stable_for_ms: 0, required_stable_ms: 200 };
  it("parses a separate immutable snapshot with an actual holding baseline", () => {
    const parsed = parseMotionHoldFailure(trigger)!;
    expect(parsed).toEqual({ reason: "position_drift", phase: "paused", capturedAtMs: 1793613261062,
      feedbackAgeMs: 4, samples: [row], stableForMs: 0, requiredStableMs: 200 });
    expect(parsed.samples[0]).not.toBe(row);
    expect(parseMotionHoldFailure({ ...trigger, reason: "velocity_timeout", samples: [{ ...row, velocity: 0 }] })?.reason).toBe("velocity_timeout");
  });
  it("rejects unknown causes, malformed timestamps and invalid diagnostic rows", () => {
    for (const value of [undefined, null, [], {}, { ...trigger, reason: "fault" }, { ...trigger, phase: "moving" },
      { ...trigger, captured_at_ms: NaN }, { ...trigger, feedback_age_ms: -1 }, { ...trigger, stable_for_ms: Infinity },
      { ...trigger, required_stable_ms: "200" }, { ...trigger, samples: [] }, { ...trigger, samples: [row, row] }])
      expect(parseMotionHoldFailure(value)).toBeUndefined();
  });
});
