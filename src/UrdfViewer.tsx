import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Vector2,
  Vector3,
} from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import URDFLoader, { type URDFRobot } from "urdf-loader";
import type { BridgeClient } from "./bridge";
import {
  cameraFacingNormal,
  intersectRayPlane,
  parseKinematics,
  resolveTcpLink,
  sceneToUrdfPoint,
} from "./kinematicsLogic";
import type { KinematicModel, Vec3 } from "./kinematicsLogic";
import { applyTrajectoryPlan, dispatchTrajectory, planTrajectory } from "./trajectoryLogic";
import type { TrajectoryController } from "./trajectoryLogic";
import type { TrajectoryPoint } from "./types";
import {
  applyJointState,
  applyUrdfVisualColors,
  decodeBase64,
  finalizeLoadedUrdfMesh,
  loadPackageResourcesSequentially,
  resolvePackageRelative,
} from "./urdfLogic";

type JointState = { name?: string[]; position?: number[] };

export type TrajectorySendRequest = { jointNames: string[]; points: TrajectoryPoint[] };
export type ViewerStatus = { kind: "info" | "success" | "error"; text: string };

const HANDLE_COLORS = { disabled: 0x4b6472, ready: 0x22d3ee, dragging: 0x7dd3fc };

function toVec3(vector: Vector3): Vec3 {
  return [vector.x, vector.y, vector.z];
}

function Controls({ robot, enabled }: { robot: URDFRobot | null; enabled: boolean }) {
  const { camera, gl } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controlsRef.current = controls;
    let frame = 0;
    const tick = () => {
      controls.update();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl]);

  useEffect(() => {
    if (controlsRef.current) controlsRef.current.enabled = enabled;
  }, [enabled]);

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

/**
 * TCP 夹爪拖拽手柄：跟随 URDF link 的世界位姿，按住后把鼠标移动映射到
 * 过 TCP 的正交平面，并把平面内的目标点交给上层做 IK。
 */
function TrajectoryHandle({
  robot,
  linkName,
  enabled,
  dragging,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  robot: URDFRobot | null;
  linkName: string;
  enabled: boolean;
  dragging: boolean;
  onDragStart(): void;
  onDragMove(target: Vec3): void;
  onDragEnd(): void;
  onDragCancel(): void;
}) {
  const { camera, gl, raycaster } = useThree();
  const groupRef = useRef<Group>(null);
  const callbacks = useRef({ onDragStart, onDragMove, onDragEnd, onDragCancel, enabled, linkName, robot });
  callbacks.current = { onDragStart, onDragMove, onDragEnd, onDragCancel, enabled, linkName, robot };

  useFrame(() => {
    const group = groupRef.current;
    const link = callbacks.current.robot?.links?.[callbacks.current.linkName];
    if (!group || !link) return;
    link.getWorldPosition(group.position);
    // 保持手柄在屏幕上的尺寸恒定，任何缩放级别都可拾取。
    group.scale.setScalar(Math.max(camera.position.distanceTo(group.position) * 0.022, 1e-4));
  });

  // 在 window 捕获阶段抢占指针事件：抓取手柄时 OrbitControls 不会同时开始旋转相机。
  // 捕获阶段从外到内派发，因此先于 canvas 上的 OrbitControls / R3F 监听器执行。
  useEffect(() => {
    const element: HTMLCanvasElement = gl.domElement;
    const drag = { planeOrigin: new Vector3(), planeNormal: new Vector3(), active: false };

    const rayFromEvent = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      raycaster.setFromCamera(
        new Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
    };

    const onPointerDown = (event: PointerEvent) => {
      const current = callbacks.current;
      if (event.target !== element) return;
      if (!current.enabled || !current.robot?.links?.[current.linkName] || !groupRef.current) return;
      rayFromEvent(event);
      if (raycaster.intersectObject(groupRef.current, true).length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      element.setPointerCapture(event.pointerId);
      groupRef.current.getWorldPosition(drag.planeOrigin);
      drag.planeNormal.set(...cameraFacingNormal(toVec3(camera.position), toVec3(drag.planeOrigin)));
      drag.active = true;
      current.onDragStart();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!drag.active) return;
      event.preventDefault();
      event.stopPropagation();
      rayFromEvent(event);
      const hit = intersectRayPlane(
        toVec3(raycaster.ray.origin),
        toVec3(raycaster.ray.direction),
        toVec3(drag.planeOrigin),
        toVec3(drag.planeNormal),
      );
      if (hit) callbacks.current.onDragMove(sceneToUrdfPoint(hit));
    };

    const finish = (event: PointerEvent) => {
      if (!drag.active) return;
      event.preventDefault();
      event.stopPropagation();
      drag.active = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      callbacks.current.onDragEnd();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.active) return;
      drag.active = false;
      callbacks.current.onDragCancel();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [camera, gl, raycaster]);

  const color = dragging ? HANDLE_COLORS.dragging : enabled ? HANDLE_COLORS.ready : HANDLE_COLORS.disabled;
  return (
    <group ref={groupRef}>
      <mesh>
        <sphereGeometry args={[1, 24, 16]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.85} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.8, 0.12, 12, 48]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.6} />
      </mesh>
    </group>
  );
}

function Scene({
  robot,
  controlsEnabled,
  children,
}: {
  robot: URDFRobot | null;
  controlsEnabled: boolean;
  children?: ReactNode;
}) {
  const grid = useMemo(() => new GridHelper(10, 20, 0x45637d, 0x24384a), []);
  const keyLight = useMemo(() => {
    const light = new DirectionalLight(new Color("#ffffff"), 1.15);
    light.position.set(3, 4, 5);
    return light;
  }, []);
  return (
    <>
      <ambientLight intensity={0.55} />
      <primitive object={keyLight} />
      <primitive object={grid} />
      {robot && <primitive object={robot} rotation={[-Math.PI / 2, 0, 0]} />}
      {children}
      <Controls robot={robot} enabled={controlsEnabled} />
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
  tcpLink,
  trajectoryController,
  onSendTrajectory,
}: {
  xml: string;
  jointState: JointState | null;
  bridge: BridgeClient;
  tcpLink: string;
  trajectoryController: TrajectoryController | null;
  onSendTrajectory(request: TrajectorySendRequest): Promise<void>;
}) {
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ target: Vec3; error: string; positionError: number } | null>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const robotRef = useRef<URDFRobot | null>(null);
  const draggingRef = useRef(false);
  const targetRef = useRef<Vec3 | null>(null);
  const seedRef = useRef<number[]>([]);
  const jointStateRef = useRef<JointState | null>(jointState);
  const controllerRef = useRef<TrajectoryController | null>(trajectoryController);
  const sendRef = useRef(onSendTrajectory);
  controllerRef.current = trajectoryController;
  sendRef.current = onSendTrajectory;

  const model = useMemo(() => {
    if (!xml.trim()) return null;
    try {
      return parseKinematics(xml) as KinematicModel;
    } catch (reason) {
      return reason instanceof Error ? reason : new Error(String(reason));
    }
  }, [xml]);

  const tcp = useMemo(() => {
    if (!model || model instanceof Error) return { name: "", error: "" };
    try {
      return { name: resolveTcpLink(model, tcpLink), error: "" };
    } catch (reason) {
      return { name: "", error: reason instanceof Error ? reason.message : String(reason) };
    }
  }, [model, tcpLink]);

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
          const complete = (object: Object3D) => {
            // URDFLoader attaches the object synchronously in done(). Applying the
            // color afterwards is required for nested meshes loaded asynchronously.
            done(object);
            finalizeLoadedUrdfMesh(object);
          };
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
        applyUrdfVisualColors(parsed);
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

  const applyState = useCallback(() => {
    applyJointState(jointStateRef.current?.name, jointStateRef.current?.position, (name, value) => {
      robotRef.current?.setJointValue(name, value);
    });
  }, []);

  useEffect(() => {
    jointStateRef.current = jointState;
    // 拖拽过程中预览位姿由 IK 驱动，不能被实时反馈覆盖。
    if (!draggingRef.current) applyState();
  }, [applyState, jointState]);

  const solvePreview = useCallback((target: Vec3) => {
    const current = model;
    if (!current || current instanceof Error || !tcp.name) return;
    targetRef.current = target;
    const result = planTrajectory({
      model: current,
      tcpLink: tcp.name,
      jointState: jointStateRef.current,
      target,
      seed: seedRef.current,
    });
    if (result.plan) {
      seedRef.current = result.plan.chainGoal;
      applyTrajectoryPlan(result.plan, (name, value) => robotRef.current?.setJointValue(name, value));
    }
    setPreview({ target, error: result.error ?? "", positionError: result.plan?.positionError ?? 0 });
  }, [model, tcp.name]);

  const handleDragStart = useCallback(() => {
    draggingRef.current = true;
    targetRef.current = null;
    seedRef.current = [];
    setDragging(true);
    setPreview(null);
    setStatus({ kind: "info", text: "拖拽中：松开鼠标下发轨迹，Esc 取消" });
  }, []);

  const handleDragMove = useCallback((target: Vec3) => solvePreview(target), [solvePreview]);

  const handleDragCancel = useCallback(() => {
    draggingRef.current = false;
    targetRef.current = null;
    setDragging(false);
    setPreview(null);
    applyState();
    setStatus({ kind: "info", text: "已取消拖拽，未下发轨迹" });
  }, [applyState]);

  const handleDragEnd = useCallback(async () => {
    draggingRef.current = false;
    setDragging(false);
    const target = targetRef.current;
    targetRef.current = null;
    if (!target) {
      setPreview(null);
      applyState();
      setStatus(null);
      return;
    }
    const current = model;
    const controller = controllerRef.current;
    if (!current || current instanceof Error || !tcp.name || !controller) {
      setPreview(null);
      applyState();
      setStatus({ kind: "error", text: "轨迹控制器未激活，未下发轨迹" });
      return;
    }
    setStatus({ kind: "info", text: `正在规划并下发轨迹到 ${controller.topic}…` });
    // 松手时按最新反馈重算一次，保证轨迹起点不落后于真实关节状态。
    const outcome = await dispatchTrajectory({
      model: current,
      tcpLink: tcp.name,
      jointState: jointStateRef.current,
      target,
      seed: seedRef.current,
      send: (request) => sendRef.current(request),
    });
    setPreview({
      target,
      error: outcome.status === "sent" ? "" : outcome.error ?? "",
      positionError: outcome.plan?.positionError ?? 0,
    });
    if (outcome.status === "sent" && outcome.plan) {
      const plan = outcome.plan;
      // 残差不为零时一并展示，避免界面暗示夹爪精确落在了目标点上。
      const residual = plan.positionError > 0.0005
        ? ` / TCP 误差 ${(plan.positionError * 1000).toFixed(1)} mm`
        : "";
      setStatus({
        kind: "success",
        text: `已下发轨迹：${plan.jointNames.length} 关节 / ${plan.points.length} 点 / ${plan.duration.toFixed(2)} s${residual}`,
      });
      return;
    }
    applyState();
    setStatus({ kind: "error", text: outcome.error ?? "轨迹下发失败，未下发轨迹" });
  }, [applyState, model, tcp.name]);

  const modelError = model instanceof Error ? model.message : "";
  const overlayError = error || modelError || tcp.error;
  const enabled = Boolean(trajectoryController && tcp.name && robot && !overlayError);

  return (
    <div className="viewer">
      {!xml && <div className="viewer-placeholder">等待 URDF Topic 数据…</div>}
      {overlayError && <div className="viewer-error">{overlayError}</div>}
      <div className="viewer-overlay" aria-live="polite">
        <div className="viewer-overlay-row">
          <span>轨迹控制器</span>
          <strong className={trajectoryController ? "ok" : "muted"}>
            {trajectoryController ? `${trajectoryController.name} · ${trajectoryController.topic}` : "未激活"}
          </strong>
        </div>
        <div className="viewer-overlay-row">
          <span>TCP</span>
          <strong className={tcp.name ? "ok" : "muted"}>{tcp.name || "未解析"}</strong>
        </div>
        <div className={`viewer-overlay-hint ${dragging ? "dragging" : ""}`}>
          {enabled
            ? dragging
              ? preview
                ? `拖拽中 · IK 误差 ${(preview.positionError * 1000).toFixed(1)} mm`
                : "拖拽中…"
              : "按住青色夹爪手柄拖拽，即可规划并下发轨迹"
            : "轨迹控制器激活后可拖拽 TCP 下发轨迹"}
        </div>
        {preview?.error && <div className="viewer-overlay-row error">{preview.error}</div>}
        {preview && !preview.error && dragging && (
          <div className="viewer-overlay-row">
            <span>目标</span>
            <strong>
              {preview.target.map((value) => value.toFixed(3)).join(", ")}
            </strong>
          </div>
        )}
        {status && <div className={`viewer-overlay-status ${status.kind}`}>{status.text}</div>}
      </div>
      <Canvas camera={{ position: [2, 2, 2], fov: 45 }} shadows>
        <color attach="background" args={["#08121d"]} />
        <Scene robot={robot} controlsEnabled={!dragging}>
          {robot && tcp.name && (
            <TrajectoryHandle
              robot={robot}
              linkName={tcp.name}
              enabled={enabled}
              dragging={dragging}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragEnd={() => void handleDragEnd()}
              onDragCancel={handleDragCancel}
            />
          )}
        </Scene>
      </Canvas>
    </div>
  );
}
