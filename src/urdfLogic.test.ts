import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import {
  applyJointState,
  applyUrdfVisualColors,
  decodeBase64,
  loadPackageResourcesSequentially,
  packageUris,
  resolvePackageRelative,
} from "./urdfLogic";

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

  it("applies a named URDF material color to meshes nested inside a visual group", () => {
    const document = new DOMParser().parseFromString(`
      <robot name="arm">
        <material name="arm_blue"><color rgba="0.1 0.4 0.8 0.65"/></material>
        <link name="base">
          <visual><geometry><mesh filename="model.dae"/></geometry><material name="arm_blue"/></visual>
        </link>
      </robot>
    `, "text/xml");
    const visual = new Group() as Group & { urdfNode: Element };
    visual.urdfNode = document.querySelector("visual")!;
    const texture = new Texture();
    const original = new MeshStandardMaterial({ color: "#ffffff", map: texture });
    const mesh = new Mesh(new BoxGeometry(), original);
    visual.add(new Group().add(mesh));
    const robot = new Group().add(visual);

    applyUrdfVisualColors(robot);

    const material = mesh.material as MeshStandardMaterial;
    expect(material).not.toBe(original);
    expect(material.color.r).toBeCloseTo(0.1);
    expect(material.color.g).toBeCloseTo(0.4);
    expect(material.color.b).toBeCloseTo(0.8);
    expect(material.opacity).toBe(0.65);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.map).toBe(texture);
  });

  it("keeps mesh-file materials when the URDF visual does not declare a color", () => {
    const document = new DOMParser().parseFromString(`
      <robot name="arm"><link name="base"><visual><geometry><mesh filename="model.dae"/></geometry></visual></link></robot>
    `, "text/xml");
    const visual = new Group() as Group & { urdfNode: Element };
    visual.urdfNode = document.querySelector("visual")!;
    const original = new MeshStandardMaterial({ color: "#cc4422" });
    const mesh = new Mesh(new BoxGeometry(), original);
    visual.add(mesh);

    applyUrdfVisualColors(new Group().add(visual));

    expect(mesh.material).toBe(original);
    expect(original.color.getHexString()).toBe("cc4422");
  });
});
