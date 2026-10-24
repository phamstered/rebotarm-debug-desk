import { LoadingManager, Mesh, MeshStandardMaterial, Texture, type Material, type Object3D } from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import URDFLoader from "urdf-loader";
import type { BridgeClient } from "./bridge";
import { applyUrdfVisualColors, finalizeLoadedUrdfMesh, packageUris, resolvePackageRelative } from "./urdfLogic";
import { loadAborted } from "./resourceCacheLogic";

export function disposeUrdfObject(root: Object3D) {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => {
      materials.add(material);
      Object.values(material).forEach((value) => { if (value instanceof Texture) textures.add(value); });
    });
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

export async function hydrateUrdfResources(xml: string, bridge: Pick<BridgeClient, "getResource">, signal: AbortSignal, progress?: (done: number, total: number) => void) {
  const urls = new Map<string, string>();
  const formats = new Map<string, string>();
  const originals = new Map<string, string>();
  const dispose = () => {
    signal.removeEventListener("abort", dispose);
    urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear();
  };
  signal.addEventListener("abort", dispose, { once: true });
  const check = () => { if (signal.aborted) throw loadAborted(); };
  const dependencyUrl = async (uri: string) => {
    if (urls.has(uri)) return urls.get(uri)!;
    const resource = await bridge.getResource(uri, signal); check();
    const url = URL.createObjectURL(new Blob([resource.bytes], { type: resource.mime }));
    urls.set(uri, url); return url;
  };
  try {
    const uris = packageUris(xml);
    for (const [index, uri] of uris.entries()) {
      check();
      try {
        const resource = await bridge.getResource(uri, signal); check();
        let bytes = resource.bytes;
        if (resource.mime === "model/vnd.collada+xml") {
          let dae = new TextDecoder().decode(bytes);
          const references = new Set([...dae.matchAll(/<init_from[^>]*>([^<]+)<\/init_from>/g)].map((match) => match[1].trim()));
          for (const reference of references) {
            if (!reference || reference.startsWith("#") || /^(data:|https?:|blob:)/.test(reference)) continue;
            const uri = resolvePackageRelative(uris[index], reference);
            dae = dae.split(reference).join(await dependencyUrl(uri));
          }
          bytes = new TextEncoder().encode(dae);
        }
        check();
        // A Collada texture may already have a URL from a previous mesh.
        const url = urls.get(uri) ?? URL.createObjectURL(new Blob([bytes], { type: resource.mime }));
        urls.set(uri, url); formats.set(url, uri.split(".").pop()?.toLowerCase() ?? ""); originals.set(url, uri);
        progress?.(index + 1, uris.length);
      } catch (reason) {
        if (signal.aborted) throw loadAborted();
        throw new Error(`URDF 资源加载失败：${uri}（${reason instanceof Error ? reason.message : String(reason)}）`);
      }
    }
    check();
    let hydrated = xml;
    [...urls].sort(([a], [b]) => b.length - a.length).forEach(([uri, url]) => { hydrated = hydrated.split(uri).join(url); });
    return { hydrated, formats, originals, dispose };
  } catch (reason) { dispose(); throw reason; }
}

export async function loadUrdfScene(assets: Awaited<ReturnType<typeof hydrateUrdfResources>>, signal: AbortSignal) {
  if (signal.aborted) throw loadAborted();
  const manager = new LoadingManager();
  const jobs: Promise<void>[] = [];
  let resolveLoaded!: () => void;
  let rejectLoaded!: (error: Error) => void;
  let failedScene = false;
  const loaded = new Promise<void>((resolve, reject) => { resolveLoaded = resolve; rejectLoaded = reject; });
  void loaded.catch(() => {});
  manager.onLoad = resolveLoaded;
  manager.onError = (url) => rejectLoaded(new Error(`资源加载失败：${assets.originals.get(url) ?? url}`));
  const loader = new URDFLoader(manager);
  loader.loadMeshCb = (path, meshManager, done) => {
    const job = new Promise<void>((resolve, reject) => {
      const failed = (reason: unknown) => {
        const error = signal.aborted ? loadAborted() : new Error(`网格解析失败：${assets.originals.get(path) ?? path}（${String(reason)}）`);
        done(null, error); reject(error);
      };
      const complete = (object: Object3D) => {
        if (signal.aborted || failedScene) { disposeUrdfObject(object); failed(loadAborted()); return; }
        done(object); finalizeLoadedUrdfMesh(object); resolve();
      };
      try {
        const format = assets.formats.get(path);
        if (format === "stl") new STLLoader(meshManager).load(path, (geometry) => complete(new Mesh(geometry, new MeshStandardMaterial({ color: "#8ca8b8", roughness: .72, metalness: .08 }))), undefined, failed);
        else if (format === "dae") new ColladaLoader(meshManager).load(path, (collada) => complete(collada.scene), undefined, failed);
        else if (format === "obj") new OBJLoader(meshManager).load(path, complete, undefined, failed);
        else failed(new Error(`不支持的网格格式：${format ?? path}`));
      } catch (reason) { failed(reason); }
    });
    jobs.push(job);
    void job.catch(() => {});
  };
  manager.itemStart("urdf-root");
  let parsed: ReturnType<URDFLoader["parse"]> | null = null;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(loadAborted()); signal.addEventListener("abort", abort, { once: true }); });
  try {
    parsed = loader.parse(assets.hydrated);
    manager.itemEnd("urdf-root");
    await Promise.race([Promise.all([...jobs, loaded]), cancelled]);
    if (signal.aborted) throw loadAborted();
    applyUrdfVisualColors(parsed);
    parsed.traverse((object) => { object.castShadow = true; object.receiveShadow = true; });
    return parsed;
  } catch (reason) { failedScene = true; if (parsed) disposeUrdfObject(parsed); throw reason; }
  finally { signal.removeEventListener("abort", abort); }
}
