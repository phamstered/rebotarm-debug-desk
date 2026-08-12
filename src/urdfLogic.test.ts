import { describe, expect, it } from "vitest";
import { applyJointState, decodeBase64, packageUris, resolvePackageRelative } from "./urdfLogic";

describe("URDF resources", () => {
  it("extracts unique package resources", () => {
    const xml = '<mesh filename="package://robot/meshes/a.stl"/><mesh filename="package://robot/meshes/a.stl"/><mesh filename="package://robot/b.dae"/>';
    expect(packageUris(xml)).toEqual(["package://robot/meshes/a.stl", "package://robot/b.dae"]);
  });

  it("resolves Collada relative texture paths without escaping package syntax", () => {
    expect(resolvePackageRelative("package://robot/meshes/arm/model.dae", "../textures/a.png"))
      .toBe("package://robot/meshes/textures/a.png");
    expect(resolvePackageRelative("package://robot/a.dae", "package://shared/a.png"))
      .toBe("package://shared/a.png");
  });

  it("decodes resource bytes", () => {
    expect([...decodeBase64("AQID")]).toEqual([1, 2, 3]);
  });

  it("maps JointState names to positions and defaults missing values to zero", () => {
    const values: Array<[string, number]> = [];
    applyJointState(["joint1", "joint2"], [.2], (name, value) => values.push([name, value]));
    expect(values).toEqual([["joint1", .2], ["joint2", 0]]);
  });
});
