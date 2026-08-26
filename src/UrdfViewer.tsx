import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import type { BridgeClient } from "./bridge";
import { applyJointState, decodeBase64, loadPackageResourcesSequentially, resolvePackageRelative } from "./urdfLogic";

type JointState = { name?: string[]; position?: number[] };

function Controls({ robot }: { robot: URDFRobot | null }) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    let frame = 0;
    const tick = () => {
      controls.update();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      controls.dispose();
    };
  }, [camera, gl]);

  useEffect(() => {
    if (!robot) return;
    const box = new Box3().setFromObject(robot);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3()).length();
    camera.position.set(center.x + size, center.y + size, center.z + size * 0.7);
    camera.lookAt(center);
    if (camera instanceof PerspectiveCamera) {
      camera.near = Math.max(size / 1000, 0.001);
      camera.far = Math.max(size * 100, 100);
      camera.updateProjectionMatrix();
    }
  }, [camera, robot]);
  return null;
}

function Scene({ robot }: { robot: URDFRobot | null }) {
  const grid = useMemo(() => new GridHelper(10, 20, 0x45637d, 0x24384a), []);
  const keyLight = useMemo(() => {
    const light = new DirectionalLight(new Color("#ffffff"), 2.2);
    light.position.set(3, 4, 5);
    return light;
  }, []);
  return (
    <>
      <ambientLight intensity={1.2} />
      <primitive object={keyLight} />
      <primitive object={grid} />
      {robot && <primitive object={robot} rotation={[-Math.PI / 2, 0, 0]} />}
      <Controls robot={robot} />
    </>
  );
}

async function hydrateResources(xml: string, bridge: BridgeClient) {
  const urls = new Map<string, string>();
  const formats = new Map<string, string>();
  const dispose = () => urls.forEach((url) => URL.revokeObjectURL(url));
  try {
    await loadPackageResourcesSequentially(xml, async (uri) => {
      const response = await bridge.request({ op: "resource", uri }, 30_000);
      if (!response.base64) throw new Error("Bridge 未返回资源内容");
      let bytes = decodeBase64(response.base64);
      let mime = response.mime ?? "application/octet-stream";

      // Collada often references textures by a path relative to the .dae file.
      // Convert those dependencies to blob URLs before handing the document to Three.js.
      if (mime === "model/vnd.collada+xml") {
        let dae = new TextDecoder().decode(bytes);
        const references = [...new Set([...dae.matchAll(/<init_from[^>]*>([^<]+)<\/init_from>/g)].map((match) => match[1].trim()))];
        for (const reference of references) {
          if (!reference || reference.startsWith("#") || /^(data:|https?:|blob:)/.test(reference)) continue;
          const dependencyUri = resolvePackageRelative(uri, reference);
          const dependency = await bridge.request({ op: "resource", uri: dependencyUri }, 30_000);
          if (!dependency.base64) throw new Error(`Bridge 未返回依赖资源：${dependencyUri}`);
          const dependencyUrl = URL.createObjectURL(new Blob(
            [decodeBase64(dependency.base64)],
            { type: dependency.mime ?? "application/octet-stream" },
          ));
          urls.set(dependencyUri, dependencyUrl);
          dae = dae.split(reference).join(dependencyUrl);
        }
        bytes = new TextEncoder().encode(dae);
        mime = "model/vnd.collada+xml";
      }

      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      urls.set(uri, url);
      formats.set(url, uri.split(".").pop()?.toLowerCase() ?? "");
    });
  } catch (reason) {
    dispose();
    throw reason;
  }
  let hydrated = xml;
  urls.forEach((url, uri) => {
    hydrated = hydrated.split(uri).join(url);
  });
  return { hydrated, formats, dispose };
}

export function UrdfViewer({
  xml,
  jointState,
  bridge,
}: {
  xml: string;
  jointState: JointState | null;
  bridge: BridgeClient;
}) {
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [error, setError] = useState("");
  const robotRef = useRef<URDFRobot | null>(null);

  useEffect(() => {
    if (!xml.trim()) {
      setRobot(null);
      return;
    }
    let disposed = false;
    let release = () => {};
    void hydrateResources(xml, bridge)
      .then(({ hydrated, formats, dispose }) => {
        release = dispose;
        const manager = new LoadingManager();
        manager.onError = (url) => setError((current) => current || `资源加载失败：${url}`);
        const loader = new URDFLoader(manager);
        loader.loadMeshCb = (path, meshManager, done) => {
          const complete = (object: Object3D) => done(object);
          const failed = (reason: unknown) => {
            const meshError = reason instanceof Error ? reason : new Error(String(reason));
            if (!disposed) setError(`网格解析失败：${path}（${meshError.message}）`);
            done(null, meshError);
          };
          const format = formats.get(path) ?? "";
          if (format === "stl") {
            new STLLoader(meshManager).load(path, (geometry) => complete(new Mesh(
              geometry,
              new MeshStandardMaterial({ color: "#8ca8b8", roughness: 0.72, metalness: 0.08 }),
            )), undefined, failed);
          } else if (format === "dae") {
            new ColladaLoader(meshManager).load(path, (collada) => complete(collada.scene), undefined, failed);
          } else if (format === "obj") {
            new OBJLoader(meshManager).load(path, complete, undefined, failed);
          } else {
            failed(new Error(`不支持的网格格式：${format || path}`));
          }
        };
        const parsed = loader.parse(hydrated);
        parsed.traverse((object) => {
          object.castShadow = true;
          object.receiveShadow = true;
        });
        if (!disposed) {
          robotRef.current = parsed;
          setRobot(parsed);
          setError("");
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      disposed = true;
      release();
    };
  }, [bridge, xml]);

  useEffect(() => {
    applyJointState(jointState?.name, jointState?.position, (name, value) => {
      robotRef.current?.setJointValue(name, value);
    });
  }, [jointState]);

  return (
    <div className="viewer">
      {!xml && <div className="viewer-placeholder">等待 URDF Topic 数据…</div>}
      {error && <div className="viewer-error">{error}</div>}
      <Canvas camera={{ position: [2, 2, 2], fov: 45 }} shadows>
        <color attach="background" args={["#08121d"]} />
        <Scene robot={robot} />
      </Canvas>
    </div>
  );
}
