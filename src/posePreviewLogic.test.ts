import { describe, expect, it } from "vitest";
import rebotarmUrdf from "./testFixtures/rebotarm-kinematics.urdf?raw";
import { ARM_JOINT_NAMES } from "./positionLogic";
import { armPosePoints } from "./posePreviewLogic";

describe("arm pose preview", () => {
  it("moves the tip when an arm joint changes", () => {
    const names = [...ARM_JOINT_NAMES];
    const folded = armPosePoints(rebotarmUrdf, names, [0, 0, 0, 0, 0, 0]);
    const bent = armPosePoints(rebotarmUrdf, names, [0.4, -1.2, -0.8, 0.3, 0.2, 0]);
    const tip = (points: number[][]) => points[points.length - 1];
    expect(folded.length).toBeGreaterThan(2);
    expect(tip(bent)).not.toEqual(tip(folded));
  });
});
