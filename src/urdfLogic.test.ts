import { describe, expect, it } from "vitest";
import { Group, Mesh, MeshStandardMaterial, Texture } from "three";
import {
  applyJointState,
  applyUrdfVisualColors,
  decodeBase64,
  finalizeLoadedUrdfMesh,
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

  it("applies a named URDF RGBA color after an async nested mesh is attached", () => {
    const document = new DOMParser().parseFromString(`
      <robot name="arm">
        <material name="arm_blue"><color rgba="0.2 0.4 0.6 0.75"/></material>
        <link name="base"><visual><geometry/><material name="arm_blue"/></visual></link>
      </robot>
    `, "application/xml");
    const visual = new Group() as Group & { isURDFVisual: boolean; urdfNode: Element };
    visual.isURDFVisual = true;
    visual.urdfNode = document.querySelector("visual")!;

    const texture = new Texture();
    const originalMaterial = new MeshStandardMaterial({ color: 0xffffff, map: texture });
    const mesh = new Mesh(undefined, originalMaterial);
    const loadedObject = new Group();
    loadedObject.add(mesh);

    // The initial post-parse pass cannot see an asynchronously loaded mesh.
    applyUrdfVisualColors(visual);
    expect(mesh.material).toBe(originalMaterial);

    // Mirrors URDFLoader's done(): attach first, then finalize the loaded object.
    visual.add(loadedObject);
    finalizeLoadedUrdfMesh(loadedObject);

    const material = mesh.material as MeshStandardMaterial;
    expect(material).not.toBe(originalMaterial);
    expect(material.color.toArray()).toEqual([0.2, 0.4, 0.6]);
    expect(material.opacity).toBe(0.75);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.map).toBe(texture);
    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
  });

  it("applies inline colors and leaves uncolored visual materials unchanged", () => {
    const document = new DOMParser().parseFromString(`
      <robot name="arm">
        <link name="colored"><visual><geometry/><material><color rgba="0.8 0.3 0.1 1"/></material></visual></link>
        <link name="plain"><visual><geometry/><material name="plain"/></visual></link>
      </robot>
    `, "application/xml");
    const visuals = [...document.querySelectorAll("visual")].map((node) => {
      const visual = new Group() as Group & { isURDFVisual: boolean; urdfNode: Element };
      visual.isURDFVisual = true;
      visual.urdfNode = node;
      visual.add(new Mesh(undefined, new MeshStandardMaterial({ color: 0xffffff })));
      return visual;
    });
    const root = new Group();
    root.add(...visuals);
    const plainMaterial = (visuals[1].children[0] as Mesh).material;

    applyUrdfVisualColors(root);

    expect(((visuals[0].children[0] as Mesh).material as MeshStandardMaterial).color.toArray())
      .toEqual([0.8, 0.3, 0.1]);
    expect((visuals[1].children[0] as Mesh).material).toBe(plainMaterial);
  });
});
