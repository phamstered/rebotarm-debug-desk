import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  PerspectiveCamera,
  Vector2,
  Vector3,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type URDFRobot } from "urdf-loader";
import { disposeUrdfObject, hydrateUrdfResources, loadUrdfScene } from "./urdfAssetLogic";
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
import { ViewerHeadsUp } from "./ViewerHeadsUp";
import { RgbdPointCloudLayer, type RgbdColorMode } from "./RgbdPointCloud";
import type { ColoredPointCloud, RgbdSessionState } from "./rgbdPointCloudLogic";
import {
  applyJointState,
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
    return () => {
      controls.dispose();
      controlsRef.current = null;
    };
  }, [camera, gl]);

  useFrame(() => controlsRef.current?.update());

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
    controlsRef.current?.target.copy(center);
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
    const drag = { planeOrigin: new Vector3(), planeNormal: new Vector3(), active: false, pointerId: -1 };

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
      drag.pointerId = event.pointerId;
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
      if (drag.active) {
        drag.active = false;
        if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
        callbacks.current.onDragCancel();
      }
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
  useEffect(() => () => {
    grid.geometry.dispose();
    (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach((material) => material.dispose());
    keyLight.shadow.dispose();
  }, [grid, keyLight]);
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

export function UrdfViewer({
  xml,
  jointState,
  bridge,
  tcpLink,
  trajectoryController,
  onSendTrajectory,
  active = true,
  rgbdCloud = null,
  rgbdVisible = true,
  rgbdPointSize = 0.008,
  rgbdColorMode = "rgb",
  rgbdNearM = 0.05,
  rgbdFarM = 3,
  rgbdStatus = null,
  onRgbdVisibleChange,
  onRgbdPointSizeChange,
  onRgbdColorModeChange,
  onRgbdNearFarChange,
}: {
  active?: boolean;
  xml: string;
  jointState: JointState | null;
  bridge: BridgeClient;
  tcpLink: string;
  trajectoryController: TrajectoryController | null;
  onSendTrajectory(request: TrajectorySendRequest): Promise<void>;
  rgbdCloud?: ColoredPointCloud | null;
  rgbdVisible?: boolean;
  rgbdPointSize?: number;
  rgbdColorMode?: RgbdColorMode;
  rgbdNearM?: number;
  rgbdFarM?: number;
  rgbdStatus?: Pick<RgbdSessionState, "stale" | "tfOk" | "tfError" | "fps" | "enabled"> & { stampDiffNs?: number; pointCount?: number } | null;
  onRgbdVisibleChange?(visible: boolean): void;
  onRgbdPointSizeChange?(size: number): void;
  onRgbdColorModeChange?(mode: RgbdColorMode): void;
  onRgbdNearFarChange?(nearM: number, farM: number): void;
}) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadedScene = useRef<{ xml: string; dispose(): void } | null>(null);
  const [loading, setLoading] = useState("");
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

  useEffect(() => () => { loadedScene.current?.dispose(); loadedScene.current = null; robotRef.current = null; }, []);
  useEffect(() => {
    if (loadedScene.current && loadedScene.current.xml !== xml) {
      loadedScene.current.dispose(); loadedScene.current = null; robotRef.current = null; setRobot(null);
    }
    if (!xml.trim() || !active || loadedScene.current?.xml === xml) return;
    const controller = new AbortController();
    let committed = false;
    setError(""); setLoading("正在获取模型资源…");
    void (async () => {
      const assets = await hydrateUrdfResources(xml, bridge, controller.signal, (done, total) => {
        if (!controller.signal.aborted) setLoading(`正在获取模型资源 ${done}/${total}…`);
      });
      try {
        if (!controller.signal.aborted) setLoading("正在解析网格…");
        const parsed = await loadUrdfScene(assets, controller.signal);
        if (controller.signal.aborted) { assets.dispose(); disposeUrdfObject(parsed); return; }
        applyJointState(jointStateRef.current?.name, jointStateRef.current?.position, (name, value) => parsed.setJointValue(name, value));
        loadedScene.current = { xml, dispose: () => { assets.dispose(); disposeUrdfObject(parsed); } };
        robotRef.current = parsed; committed = true; setRobot(parsed); setLoading("");
      } catch (reason) { assets.dispose(); throw reason; }
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(""); }
    });
    return () => { if (!committed) controller.abort(); };
  }, [bridge, xml, active]);

  const applyState = useCallback(() => {
    applyJointState(jointStateRef.current?.name, jointStateRef.current?.position, (name, value) => {
      robotRef.current?.setJointValue(name, value);
    });
  }, []);

  useEffect(() => {
    jointStateRef.current = jointState;
    // 拖拽过程中预览位姿由 IK 驱动，不能被实时反馈覆盖。
    if (active && !draggingRef.current) applyState();
  }, [applyState, jointState, active]);

  const solvePreview = useCallback((target: Vec3) => {
    const current = model;
    if (!current || current instanceof Error || !tcp.name) return;
    targetRef.current = target;
    const result = planTrajectory({
      model: current,
      tcpLink: tcp.name,
      jointState: jointStateRef.current,
      controllerJointNames: controllerRef.current?.jointNames ?? [],
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

  useEffect(() => { if (!active && draggingRef.current) handleDragCancel(); }, [active, handleDragCancel]);

  const handleDragEnd = useCallback(async () => {
    if (!activeRef.current) { handleDragCancel(); return; }
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
      controllerJointNames: controller.jointNames ?? [],
      target,
      seed: seedRef.current,
      send: (request) => {
        if (!activeRef.current) return Promise.reject(new Error("Robot View 已隐藏，未下发轨迹"));
        return sendRef.current(request);
      },
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
  }, [applyState, model, tcp.name, handleDragCancel]);

  const modelError = model instanceof Error ? model.message : "";
  const overlayError = error || modelError || tcp.error;
  const enabled = Boolean(active && trajectoryController?.jointNames?.length && !trajectoryController.readinessError && tcp.name && robot && !overlayError);

  return (
    <div className="viewer">
      {!xml && <div className="viewer-placeholder">等待 URDF Topic 数据…</div>}
      <ViewerHeadsUp error={overlayError}>
        {loading && <div className="viewer-overlay-status" role="status">{loading}</div>}
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
            : trajectoryController
              ? trajectoryController.readinessError || "等待轨迹控制器关节反馈后可拖拽 TCP"
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
        {rgbdStatus?.enabled !== false && (
          <div className="viewer-overlay-rgbd" data-testid="rgbd-controls">
            <div className="viewer-overlay-row">
              <label><input type="checkbox" checked={rgbdVisible} onChange={(e) => onRgbdVisibleChange?.(e.target.checked)} /> 点云</label>
              <select value={rgbdColorMode} onChange={(e) => onRgbdColorModeChange?.(e.target.value as RgbdColorMode)} aria-label="点云着色">
                <option value="rgb">RGB</option>
                <option value="depth">深度</option>
              </select>
            </div>
            <div className="viewer-overlay-row">
              <span>点大小</span>
              <input type="range" min={0.002} max={0.03} step={0.001} value={rgbdPointSize}
                onChange={(e) => onRgbdPointSizeChange?.(Number(e.target.value))} />
            </div>
            <div className="viewer-overlay-row">
              <span>近/远 m</span>
              <input type="number" step={0.05} value={rgbdNearM} aria-label="近距"
                onChange={(e) => onRgbdNearFarChange?.(Number(e.target.value), rgbdFarM)} />
              <input type="number" step={0.1} value={rgbdFarM} aria-label="远距"
                onChange={(e) => onRgbdNearFarChange?.(rgbdNearM, Number(e.target.value))} />
            </div>
            <div className="viewer-overlay-row">
              <span>RGBD</span>
              <strong>
                {(rgbdStatus?.fps ?? 0).toFixed(1)} Hz · {rgbdStatus?.pointCount ?? 0} pts
                {rgbdStatus?.stampDiffNs != null ? ` · Δ${(rgbdStatus.stampDiffNs / 1e6).toFixed(1)}ms` : ""}
                {rgbdStatus?.stale ? " · 过期" : ""}
              </strong>
            </div>
            {!rgbdStatus?.tfOk && rgbdStatus?.tfError && (
              <div className="viewer-overlay-row error" role="alert">{rgbdStatus.tfError}</div>
            )}
          </div>
        )}
      </ViewerHeadsUp>
      <Canvas frameloop={active ? "always" : "never"} camera={{ position: [2, 2, 2], fov: 45 }} shadows>
        <color attach="background" args={["#08121d"]} />
        <Scene robot={robot} controlsEnabled={active && !dragging}>
          {/* Point cloud is parented under the same URDF root rotation; positions already converted via urdfToScenePoint. */}
          <RgbdPointCloudLayer
            cloud={rgbdCloud}
            visible={rgbdVisible}
            pointSize={rgbdPointSize}
            colorMode={rgbdColorMode}
            nearM={rgbdNearM}
            farM={rgbdFarM}
          />
          {active && robot && tcp.name && (
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
