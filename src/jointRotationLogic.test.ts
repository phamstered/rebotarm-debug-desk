import { describe, expect, it } from "vitest";
import { parseKinematics } from "./kinematicsLogic";
import { degreesToRadians, jointFeedback, pickedRotationJoint, radiansToDegrees, rotationalJoints, rotationInput } from "./jointRotationLogic";

export const jointXml = `<robot name="joints"><link name="base"/><link name="a"/><link name="b"/><link name="c"/><link name="finger"/>
<joint name="joint1" type="revolute"><parent link="base"/><child link="a"/><axis xyz="0 1 0"/><limit lower="-1.57" upper="1.57"/></joint>
<joint name="joint2" type="continuous"><parent link="a"/><child link="b"/><axis xyz="1 0 0"/></joint>
<joint name="fixed" type="fixed"><parent link="b"/><child link="c"/></joint>
<joint name="copy" type="revolute"><parent link="c"/><child link="finger"/><mimic joint="joint1"/></joint></robot>`;

describe("independent joint rotation", () => {
  const model = parseKinematics(jointXml), joint = model.joints[0];
  it("selects independent rotary joints and resolves the nearest movable mesh ancestor", () => {
    expect(rotationalJoints(model).map((j) => j.name)).toEqual(["joint1", "joint2"]);
    expect(pickedRotationJoint(model, ["mesh", "finger", "copy", "c", "fixed", "b", "joint2", "a"])).toBe("joint2");
    expect(pickedRotationJoint(model, ["visual", "a", "joint1", "base"])).toBe("joint1");
    expect(pickedRotationJoint(model, ["grid"])).toBeNull();
  });
  it("converts degrees without wrapping a continuous joint or silently accepting limits/nonfinite input", () => {
    expect(rotationInput(joint, "-30").position).toBeCloseTo(-Math.PI / 6);
    for (const text of ["", "-", "NaN", "Infinity", "100", "1e309"])
      expect(rotationInput(joint, text).error).not.toBe("");
    expect(rotationInput(joint, String(radiansToDegrees(joint.upper))).position).toBe(joint.upper);
    expect(rotationInput(model.joints[1], "720").position).toBeCloseTo(4 * Math.PI);
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI);
  });
  it("requires unambiguous finite feedback", () => {
    expect(jointFeedback(["joint2", "joint1"], [.2, .1], "joint1")).toBe(.1);
    expect(jointFeedback(["joint1", "joint1"], [0, 1], "joint1")).toBeNull();
    expect(jointFeedback(["joint1"], [NaN], "joint1")).toBeNull();
    expect(jointFeedback(["joint2"], [0], "joint1")).toBeNull();
  });
});
