import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import {
  axisRayParameter,
  moveTcpPose,
  poseFromInputs,
  poseRpyDegrees,
  rayRingVector,
  type TcpTargetPose,
} from "./tcpPoseInteractionLogic";
describe("TCP six-axis interaction geometry", () => {
  const pose: TcpTargetPose = {
    position: [0.1, 0.2, 0.3],
    orientation: [0, 0, 0, 1],
  };
  it("converts mm and fixed XYZ RPY using RzRyRx, with finite validation", () => {
    const target = poseFromInputs([
      "100",
      "200",
      "300",
      "30",
      "40",
      "50",
    ]).pose!;
    expect(target.position).toEqual(pose.position);
    const expected = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 0, 1), (50 * Math.PI) / 180)
      .multiply(
        new Quaternion().setFromAxisAngle(
          new Vector3(0, 1, 0),
          (40 * Math.PI) / 180,
        ),
      )
      .multiply(
        new Quaternion().setFromAxisAngle(
          new Vector3(1, 0, 0),
          (30 * Math.PI) / 180,
        ),
      );
    expect(
      new Quaternion(...target.orientation).angleTo(expected),
    ).toBeLessThan(1e-7);
    poseRpyDegrees(target).forEach((value, i) =>
      expect(value).toBeCloseTo([30, 40, 50][i]),
    );
    for (const bad of ["", "-", "NaN", "Infinity"])
      expect(poseFromInputs([bad, "0", "0", "0", "0", "0"]).error).not.toBe("");
  });
  it("preserves orientation during translation and position during rotation in base/tool frames", () => {
    const turned = moveTcpPose(pose, 2, "base", Math.PI / 2, true);
    expect(turned.position).toEqual(pose.position);
    const translated = moveTcpPose(turned, 0, "tool", 0.1, false);
    expect(translated.position[0]).toBeCloseTo(0.1);
    expect(translated.position[1]).toBeCloseTo(0.3);
    expect(translated.orientation).toEqual(turned.orientation);
    const base = moveTcpPose(turned, 0, "base", 0.1, false);
    expect(base.position).toEqual([0.2, 0.2, 0.3]);
    const baseRot = moveTcpPose(turned, 0, "base", 0.2, true),
      toolRot = moveTcpPose(turned, 0, "tool", 0.2, true);
    expect(
      new Quaternion(...baseRot.orientation).angleTo(
        new Quaternion(...toolRot.orientation),
      ),
    ).toBeGreaterThan(0.1);
    expect(Math.hypot(...toolRot.orientation)).toBeCloseTo(1);
  });
  it("projects axis/ring drags and safely rejects edge-on or backwards rays", () => {
    const p = new Vector3(),
      axis = new Vector3(1, 0, 0),
      origin = new Vector3(0.2, 0, 1),
      dir = new Vector3(0, 0, -1);
    expect(axisRayParameter(origin, dir, p, axis, dir)).toBeCloseTo(0.2);
    expect(axisRayParameter(origin, dir, p, axis, axis)).toBeNull();
    expect(
      rayRingVector(origin, dir, p, new Vector3(0, 0, 1))?.toArray(),
    ).toEqual([1, 0, 0]);
    expect(rayRingVector(origin, dir, p, axis)).toBeNull();
    expect(
      rayRingVector(origin, new Vector3(0, 0, 1), p, new Vector3(0, 0, 1)),
    ).toBeNull();
  });
});
