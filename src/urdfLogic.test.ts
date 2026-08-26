import { describe, expect, it } from "vitest";
import { applyJointState, decodeBase64, loadPackageResourcesSequentially, packageUris, resolvePackageRelative } from "./urdfLogic";

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

  it("loads large package resources sequentially instead of starting all timeouts together", async () => {
    let releaseFirst!: () => void;
    const firstResource = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const loading = loadPackageResourcesSequentially(
      '<mesh filename="package://robot/a.stl"/><mesh filename="package://robot/b.stl"/>',
      async (uri) => {
        calls.push(uri);
        if (uri.endsWith("a.stl")) await firstResource;
      },
    );
    await Promise.resolve();
    expect(calls).toEqual(["package://robot/a.stl"]);
    releaseFirst();
    await loading;
    expect(calls).toEqual(["package://robot/a.stl", "package://robot/b.stl"]);
  });

  it("identifies the package URI when a resource fails", async () => {
    await expect(loadPackageResourcesSequentially(
      '<mesh filename="package://robot/missing.stl"/>',
      async () => { throw new Error("resource 请求超时"); },
    )).rejects.toThrow("package://robot/missing.stl（resource 请求超时）");
  });

  it("maps JointState names to positions and defaults missing values to zero", () => {
    const values: Array<[string, number]> = [];
    applyJointState(["joint1", "joint2"], [.2], (name, value) => values.push([name, value]));
    expect(values).toEqual([["joint1", .2], ["joint2", 0]]);
  });
});
