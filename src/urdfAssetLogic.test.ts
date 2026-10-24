import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
const meshLoads = vi.hoisted(() => [] as { complete(object: unknown): void; fail(): void; finishTexture(): void }[]);
vi.mock("three/examples/jsm/loaders/STLLoader.js", () => ({ STLLoader: class {
  constructor(private manager: { itemStart(url: string): void; itemEnd(url: string): void; itemError(url: string): void }) {}
  load(path: string, done: (geometry: unknown) => void, _progress: unknown, error: (reason: unknown) => void) {
    const texture = `${path}-texture`;
    this.manager.itemStart(path); this.manager.itemStart(texture);
    meshLoads.push({
      complete: (geometry) => { done(geometry); this.manager.itemEnd(path); },
      fail: () => { error(Error("broken mesh")); this.manager.itemError(path); this.manager.itemEnd(path); this.manager.itemEnd(texture); },
      finishTexture: () => this.manager.itemEnd(texture),
    });
  }
} }));
import { disposeUrdfObject, hydrateUrdfResources, loadUrdfScene } from "./urdfAssetLogic";
const xml = '<robot name="test"><link name="base"><visual><geometry><mesh filename="package://test/a.stl"/></geometry></visual></link></robot>';
const bytes = (text = "mesh", mime = "model/stl") => ({ bytes: new TextEncoder().encode(text), mime });

describe("URDF assets", () => {
  beforeEach(() => {
    meshLoads.length = 0;
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn().mockReturnValue("blob:mesh"), revokeObjectURL: vi.fn() }));
  });
  it("cancels obsolete transfers before requesting later resources and revokes scene URLs", async () => {
    const controller = new AbortController();
    let complete!: (value: ReturnType<typeof bytes>) => void;
    const getResource = vi.fn().mockResolvedValueOnce(bytes()).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = hydrateUrdfResources(`${xml} package://test/b.stl package://test/c.stl`, { getResource }, controller.signal);
    await vi.waitFor(() => expect(getResource).toHaveBeenCalledTimes(2));
    controller.abort();
    // A transport that respects abort rejects its pending request; this mock deliberately ignores it.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mesh");
    expect(getResource).toHaveBeenCalledTimes(2);
    complete(bytes());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(getResource).toHaveBeenCalledTimes(2);
    const pre = new AbortController(); pre.abort();
    await expect(hydrateUrdfResources(xml, { getResource }, pre.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("reports the original failed URI and cleans already hydrated assets", async () => {
    const getResource = vi.fn().mockResolvedValueOnce(bytes()).mockRejectedValueOnce(Error("missing"));
    await expect(hydrateUrdfResources(`${xml} package://test/b.stl`, { getResource }, new AbortController().signal)).rejects.toThrow("package://test/b.stl（missing）");
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
  it("resolves shared Collada textures once and keeps URL ownership local to the scene", async () => {
    const getResource = vi.fn(async (uri: string) => uri.endsWith(".dae")
      ? bytes('<COLLADA><init_from>textures/a.png</init_from></COLLADA>', "model/vnd.collada+xml") : bytes("png", "image/png"));
    vi.mocked(URL.createObjectURL).mockReturnValueOnce("blob:texture").mockReturnValueOnce("blob:a").mockReturnValueOnce("blob:b");
    const result = await hydrateUrdfResources("package://test/a.dae package://test/b.dae", { getResource }, new AbortController().signal);
    expect(getResource.mock.calls.map(([uri]) => uri)).toEqual(["package://test/a.dae", "package://test/textures/a.png", "package://test/b.dae"]);
    expect(result.hydrated).toBe("blob:a blob:b");
    result.dispose(); result.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
  it("waits for meshes and their manager dependencies before publishing the scene", async () => {
    const assets = await hydrateUrdfResources(xml, { getResource: vi.fn().mockResolvedValue(bytes()) }, new AbortController().signal);
    let settled = false;
    const scene = loadUrdfScene(assets, new AbortController().signal).then((value) => { settled = true; return value; });
    expect(meshLoads).toHaveLength(1);
    meshLoads[0].complete(new BoxGeometry());
    await Promise.resolve(); expect(settled).toBe(false);
    meshLoads[0].finishTexture();
    expect((await scene).links.base).toBeDefined();
  });
  it("rejects aborted scenes and disposes meshes arriving after cancellation", async () => {
    const assets = await hydrateUrdfResources(xml, { getResource: vi.fn().mockResolvedValue(bytes()) }, new AbortController().signal);
    const controller = new AbortController();
    const scene = loadUrdfScene(assets, controller.signal);
    controller.abort();
    await expect(scene).rejects.toMatchObject({ name: "AbortError" });
    const geometry = new BoxGeometry(), dispose = vi.spyOn(geometry, "dispose");
    meshLoads[0].complete(geometry); meshLoads[0].finishTexture();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("rejects mesh errors with the original URI and handles primitive-only scenes", async () => {
    const assets = await hydrateUrdfResources(xml, { getResource: vi.fn().mockResolvedValue(bytes()) }, new AbortController().signal);
    const scene = loadUrdfScene(assets, new AbortController().signal);
    meshLoads[0].fail();
    await expect(scene).rejects.toThrow("package://test/a.stl");
    await expect(loadUrdfScene({ ...assets, hydrated: '<robot name="test"><link name="base"/></robot>' }, new AbortController().signal)).resolves.toMatchObject({ name: "base" });
  });
  it("disposes shared geometry, material and texture only once", () => {
    const root = new Group(), geometry = new BoxGeometry(), texture = new Texture(), material = new MeshStandardMaterial({ map: texture });
    root.add(new Mesh(geometry, material), new Mesh(geometry, material));
    const spies = [geometry, texture, material].map((value) => vi.spyOn(value, "dispose"));
    disposeUrdfObject(root); spies.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
  });
});
