import { VisualPickPanel } from "./VisualPickPanel";
import { VisualPickPreviewLayer } from "./VisualPickPreviewLayer";
import type { VisualPickPreview, ObjectBox } from "./types";
import { ObjectDetectionLayer } from "./ObjectDetectionLayer";
import { ObjectDetectionControls } from "./ObjectDetectionControls";
import { ClockSyncStatus } from "./ClockSyncStatus";
import type { ClockSyncStatus as ClockStatus } from "./clockSyncLogic";
import { GRIPPER_JOINT_NAME } from "./positionLogic";
import { MotionTerminal } from "./MotionTerminal";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  PerspectiveCamera,
  Vector3,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { type URDFRobot } from "urdf-loader";
import { disposeUrdfObject, hydrateUrdfResources, loadUrdfScene } from "./urdfAssetLogic";
import type { BridgeClient } from "./bridge";
import {
  chainToLink,
  actuatedJoints,
  forwardKinematics,
  parseKinematics,
  resolveTcpLink,
} from "./kinematicsLogic";
import type { KinematicJoint, KinematicModel, Vec3 } from "./kinematicsLogic";
import { TcpPoseHandle } from "./TcpPoseHandle";
import { useWorkspaceMenu } from "./WorkspaceMenu";
import { useMotionLayout } from "./MotionLayout";
import { TcpPosePanel } from "./TcpPosePanel";
import type { TcpHandleFrame, TcpTargetPose } from "./tcpPoseInteractionLogic";
import { JointRotationPanel } from "./JointRotationPanel";
import { pickedRotationJoint, rotationalJoints, type JointRotationPreview } from "./jointRotationLogic";
import type { PositionMotionControls } from "./positionMotionLogic";
import { applyTrajectoryPlan, planTrajectory } from "./trajectoryLogic";
import type { TrajectoryController } from "./trajectoryLogic";
import type { TrajectoryPoint } from "./types";
import { MotionControlPanel, type MotionControlInfo } from "./MotionControlPanel";
import { ViewerHeadsUp } from "./ViewerHeadsUp";
import { RgbdPointCloudLayer, type RgbdColorMode } from "./RgbdPointCloud";
import type { ColoredPointCloud, RgbdSessionState } from "./rgbdPointCloudLogic";
import {
  applyJointState,
} from "./urdfLogic";

type JointState = { name?: string[]; position?: number[] };

export type TrajectorySendRequest = { jointNames: string[]; points: TrajectoryPoint[] };
export type ViewerStatus = { kind: "info" | "success" | "error"; text: string };

type CameraView = {name:"fit"|"front"|"side"|"top";revision:number};
function Controls({ robot, enabled, view }: { robot: URDFRobot | null; enabled: boolean; view:CameraView }) {
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
    const direction = view.name==='front' ? new Vector3(0,0,1) : view.name==='side' ? new Vector3(1,0,0) : view.name==='top' ? new Vector3(0,1,.001) : new Vector3(1,1,.7);
    camera.position.copy(center).addScaledVector(direction.normalize(),Math.max(.1,size)*1.5);
    controlsRef.current?.target.copy(center);
    camera.lookAt(center);
    if (camera instanceof PerspectiveCamera) {
      camera.near = Math.max(size / 1000, 0.001);
      camera.far = Math.max(size * 100, 100);
      camera.updateProjectionMatrix();
    }
  }, [camera, robot, view]);
  return null;
}

function Scene({
  robot,
  controlsEnabled,
  view, showGrid, showAxes,
  children,
  onPick,
}: {
  robot: URDFRobot | null;
  controlsEnabled: boolean;
  view: CameraView; showGrid:boolean; showAxes:boolean;
  children?: ReactNode;
  onPick?(event: ThreeEvent<MouseEvent>): void;
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
      {showGrid && <primitive object={grid} />}
      {showAxes && <axesHelper args={[.25]} />}
      {robot && <primitive object={robot} rotation={[-Math.PI / 2, 0, 0]} onClick={onPick} />}
      {children}
      <Controls robot={robot} enabled={controlsEnabled} view={view} />
    </>
  );
}

function JointAxisMarker({ robot, joint }: { robot: URDFRobot; joint: KinematicJoint }) {
  const group = useRef<Group>(null);
  const { camera } = useThree();
  const axis = useMemo(() => new Vector3(...joint.axis).normalize(), [joint]);
  useFrame(() => {
    const marker = group.current, link = robot.links?.[joint.child];
    if (!marker) return;
    marker.visible = Boolean(link);
    if (!link) return;
    link.getWorldPosition(marker.position);
    const direction = axis.clone().applyQuaternion(link.getWorldQuaternion(marker.quaternion));
    marker.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), direction);
    marker.scale.setScalar(Math.max(camera.position.distanceTo(marker.position) * 0.035, 1e-4));
  });
  return <group ref={group} visible={false}>
    <mesh>{joint.type === "prismatic" ? <boxGeometry args={[.15, .15, 2]} /> : <torusGeometry args={[1, .045, 8, 64]} />}<meshBasicMaterial color="#fbbf24" depthTest={false} transparent opacity={.9} /></mesh>
    <mesh rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[.025, .025, 3, 8]} /><meshBasicMaterial color="#fbbf24" depthTest={false} transparent opacity={.8} /></mesh>
  </group>;
}
export function UrdfViewer({
  xml,
  jointState: rawJointState,
  bridge,
  tcpLink,
  trajectoryController,
  onSendTrajectory: _onSendTrajectory,
  active = true,
  motionInfo = { state: "idle" },
  jointMotion: providedJointMotion,
  plannerLog,
  showMotionTerminal = true,
  onSavePose,
  savePoseDisabledReason = "",
  savePoseError = "",
  rgbdCloud = null,
  rgbdSubscriptionId,
  rgbdVisible = true,
  rgbdPointSize = 0.008,
  rgbdColorMode = "rgb",
  rgbdNearM = 0.05,
  rgbdFarM = 3,
  rgbdStatus = null,
  visualPickSupported = false,
  objectsEnabled = false, objectsSupported = false, onObjectsEnabledChange,
  clockSync,
  onRgbdVisibleChange,
  onRgbdPointSizeChange,
  onRgbdColorModeChange,
  onRgbdNearFarChange,
}: {
  active?: boolean;
  motionInfo?: MotionControlInfo;
  jointMotion?: PositionMotionControls;
  plannerLog?: ReactNode;
  showMotionTerminal?: boolean;
  onSavePose?(): void;
  savePoseDisabledReason?: string;
  savePoseError?: string;
  xml: string;
  jointState: JointState | null;
  bridge: BridgeClient;
  tcpLink: string;
  trajectoryController: TrajectoryController | null;
  onSendTrajectory(request: TrajectorySendRequest): Promise<void>;
  clockSync?: ClockStatus;
  rgbdCloud?: ColoredPointCloud | null;
  rgbdSubscriptionId?: string;
  visualPickSupported?: boolean;
  objectsEnabled?: boolean; objectsSupported?: boolean; onObjectsEnabledChange?(value: boolean): void;
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
  const [visualBusy,setVisualBusy]=useState(false),[visualPreview,setVisualPreview]=useState<VisualPickPreview|null>(null);
  const [selection,setSelection]=useState<{token:string;id:number;box:ObjectBox;revision:number}|null>(null);
  const token=rgbdSubscriptionId??rgbdCloud?.subscriptionId??"";
  const selected=selection?.token===token?selection.box:null;
  const visualActive=active&&objectsEnabled&&rgbdVisible&&visualPickSupported&&Boolean(token);
  useEffect(()=>{if(!active||!objectsEnabled||!rgbdVisible||selection?.token!==token){setSelection(null);setVisualPreview(null);}},[active,objectsEnabled,rgbdVisible,token,selection?.token]);
  const jointMotion=providedJointMotion?{...providedJointMotion,busy:providedJointMotion.busy||visualBusy}:undefined;
  const jointState = useMemo(() => {
    if (!rawJointState) return null;
    const names: string[] = [], positions: number[] = [];
    rawJointState.name?.forEach((name, i) => { if (name !== GRIPPER_JOINT_NAME) { names.push(name); positions.push(rawJointState.position?.[i] ?? NaN); } });
    if (jointMotion?.gripper?.fresh && jointMotion.gripper.position !== undefined) {
      names.push(GRIPPER_JOINT_NAME); positions.push(jointMotion.gripper.position);
    }
    return { name: names, position: positions };
  }, [rawJointState, jointMotion?.gripper?.position, jointMotion?.gripper?.fresh]);
  const [objectLabels, setObjectLabels] = useState(true), [objectDimensions, setObjectDimensions] = useState(false);
  const layout=useMotionLayout();
  const [cameraView,setCameraView]=useState<CameraView>({name:'fit',revision:0});
  const [showGrid,setShowGrid]=useState(true), [showAxes,setShowAxes]=useState(false), [revealControls,setRevealControls]=useState(0);
  const canvasMenu=useWorkspaceMenu([
    ...([['fit','适应模型'],['front','正视图'],['side','侧视图'],['top','俯视图']] as const).map(([name,label])=>({label,run:()=>setCameraView(v=>({name,revision:v.revision+1}))})),
    {label:showGrid?'隐藏网格':'显示网格',run:()=>setShowGrid(v=>!v)},
    {label:showAxes?'隐藏坐标轴':'显示坐标轴',run:()=>setShowAxes(v=>!v)},
    {label:'打开 TCP / 关节操作',run:()=>{layout?.exitFocus?.();setRevealControls(v=>v+1);}}
  ],'画布视图',active);
  const [targetPose, setTargetPose] = useState<TcpTargetPose | null>(null);
  const [handleFrame, setHandleFrame] = useState<TcpHandleFrame>("base");
  const [poseInputError, setPoseInputError] = useState("");
  const [tcpPending, setTcpPending] = useState(false);
  const tcpPendingRef = useRef(false);
  const [gripperText, setGripperText] = useState("");
  const gripperTarget = gripperText.trim() ? Number(gripperText) / 1000 : undefined;
  const gripperTargetRef = useRef(gripperTarget);
  gripperTargetRef.current = gripperTarget;
  const activeRef = useRef(active);
  activeRef.current = active;
  const loadedScene = useRef<{ xml: string; dispose(): void } | null>(null);
  const [loading, setLoading] = useState("");
  const [robot, setRobot] = useState<URDFRobot | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<{ target: Vec3; error: string; positionError: number; orientationError: number } | null>(null);
  const [status, setStatus] = useState<ViewerStatus | null>(null);
  const robotRef = useRef<URDFRobot | null>(null);
  const draggingRef = useRef(false);
  const targetRef = useRef<TcpTargetPose | null>(null);
  const seedRef = useRef<number[]>([]);
  const jointStateRef = useRef<JointState | null>(jointState);
  const controllerRef = useRef<TrajectoryController | null>(trajectoryController);
  const [interaction, setInteraction] = useState<"tcp" | "joint">("tcp");
  const [selectedJoint, setSelectedJoint] = useState("");
  const [jointPreviewReset, setJointPreviewReset] = useState(0);
  const [jointPreview, setJointPreview] = useState<JointRotationPreview | null>(null);
  const jointPreviewRef = useRef<JointRotationPreview | null>(null);
  controllerRef.current = trajectoryController;

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

  const handleSession = useMemo(() => crypto.randomUUID(), [bridge, xml, tcp.name]);
  const actualPose = useMemo<TcpTargetPose | null>(() => {
    if (!model || model instanceof Error || !tcp.name || !jointState?.name || !jointState.position) return null;
    if (new Set(jointState.name).size !== jointState.name.length) return null;
    try {
      const chain = chainToLink(model, tcp.name);
      const values = actuatedJoints(chain).map((joint) => jointState.position![jointState.name!.indexOf(joint.name)]);
      if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
      const fk = forwardKinematics(chain, values);
      return { position: fk.position, orientation: fk.quaternion };
    } catch { return null; }
  }, [model, tcp.name, jointState]);
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
    const g = gripperTargetRef.current;
    if (activeRef.current && g !== undefined && Number.isFinite(g)) robotRef.current?.setJointValue(GRIPPER_JOINT_NAME, g);
    const value = jointPreviewRef.current;
    if (activeRef.current && value) for (const [name, position] of Object.entries(value)) robotRef.current?.setJointValue(name, position);
  }, []);

  const previewJoint = useCallback((value: JointRotationPreview | null) => {
    jointPreviewRef.current = value;
    setJointPreview(value);
    applyState();
  }, [applyState]);
  const selectJoint = useCallback((name: string) => {
    setSelectedJoint(name);
  }, [previewJoint]);
  useEffect(() => { previewJoint(null); setJointPreviewReset((value) => value + 1); setSelectedJoint(""); }, [xml, bridge, previewJoint]);
  useEffect(() => { if (!active || jointMotion?.busy) previewJoint(null); }, [active, jointMotion?.busy, previewJoint]);
  useEffect(() => {
    if (!jointPreview) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { previewJoint(null); setJointPreviewReset((value) => value + 1); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [jointPreview, previewJoint]);

  useEffect(() => {
    jointStateRef.current = jointState;
    // 拖拽过程中预览位姿由 IK 驱动，不能被实时反馈覆盖。
    if (active && !draggingRef.current && !tcpPendingRef.current) applyState();
  }, [applyState, jointState, active]);

  const solvePreview = useCallback((target: TcpTargetPose) => {
    const current = model;
    if (!current || current instanceof Error || !tcp.name) return;
    targetRef.current = target; setTargetPose(target);
    tcpPendingRef.current = true; setTcpPending(true);
    const result = planTrajectory({
      model: current,
      tcpLink: tcp.name,
      jointState: jointStateRef.current,
      controllerJointNames: controllerRef.current?.jointNames ?? [],
      target: target.position,
      targetQuaternion: target.orientation,
      seed: seedRef.current,
    });
    if (result.plan) {
      seedRef.current = result.plan.chainGoal;
      applyTrajectoryPlan(result.plan, (name, value) => robotRef.current?.setJointValue(name, value));
    }
    if (Number.isFinite(gripperTargetRef.current)) robotRef.current?.setJointValue(GRIPPER_JOINT_NAME, gripperTargetRef.current!);
    setPreview({ target: target.position, error: result.error ?? "", positionError: result.plan?.positionError ?? 0, orientationError: result.plan?.orientationError ?? Infinity });
  }, [model, tcp.name]);

  const handleDragStart = useCallback(() => {
    draggingRef.current = true;
    tcpPendingRef.current = false; setTcpPending(false);
    seedRef.current = [];
    setDragging(true);
    setPreview(null);
    jointMotion?.recordLog("tcp-preview", "开始 TCP 拖拽预览");
    setStatus({ kind: "info", text: "拖拽中：松开鼠标保留预览，确认后执行，Esc 取消" });
  }, [jointMotion?.recordLog]);

  const handleDragMove = useCallback((target: TcpTargetPose) => solvePreview(target), [solvePreview]);

  const handleDragCancel = useCallback(() => {
    draggingRef.current = false;
    targetRef.current = null; setTargetPose(null); setPoseInputError("");
    tcpPendingRef.current = false; setTcpPending(false); setGripperText(""); gripperTargetRef.current = undefined;
    setDragging(false);
    setPreview(null);
    applyState();
    jointMotion?.recordLog("tcp-cancel", "已取消拖拽，未下发轨迹");
    setStatus({ kind: "info", text: "已取消拖拽，未下发轨迹" });
  }, [applyState, jointMotion?.recordLog]);

  useEffect(() => { if (!active && draggingRef.current) handleDragCancel(); }, [active, handleDragCancel]);

  const handleDragEnd = useCallback(() => {
    draggingRef.current = false; setDragging(false);
    if (!activeRef.current) { handleDragCancel(); return; }
    if (targetRef.current) {
      tcpPendingRef.current = true; setTcpPending(true);
      setStatus({ kind: "info", text: "目标预览中，确认后由 MoveIt 规划执行" });
    } else handleDragCancel();
  }, [handleDragCancel]);

  const confirmTcp = async () => {
    if (!activeRef.current || draggingRef.current || jointMotion?.busy || !jointMotion?.armed || poseInputError) return;
    const target = targetRef.current;
    if (target) {
      if (!model || model instanceof Error || !tcp.name || !jointMotion.executeTcpPose || jointMotion.tcpPoseReason) return;
      const result = planTrajectory({ model, tcpLink: tcp.name, jointState: jointStateRef.current,
        controllerJointNames: controllerRef.current?.jointNames ?? [], target: target.position, targetQuaternion: target.orientation, seed: seedRef.current });
      if (result.error || !result.plan || !Number.isFinite(result.plan.orientationError) || result.plan.positionError > .005 || result.plan.orientationError! > .02) { setStatus({ kind: "error", text: result.error || "位姿 IK 未收敛" }); return; }
      const pose = { frame_id: model.rootLink, tcp_link: tcp.name, position: [...target.position] as Vec3, orientation: [...target.orientation] as typeof target.orientation };
      handleDragCancel();
      await jointMotion.executeTcpPose(pose, Math.max(5, result.plan.duration), gripperTarget);
    } else if (gripperTarget !== undefined && !jointMotion.jointTargetsReason) {
      handleDragCancel();
      await jointMotion.executeJoints({ [GRIPPER_JOINT_NAME]: gripperTarget }, 5);
    }
  };
  useEffect(() => {
    if ((!active || jointMotion?.busy) && (draggingRef.current || tcpPendingRef.current || gripperTargetRef.current !== undefined)) handleDragCancel();
  }, [active, jointMotion?.busy, handleDragCancel]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && (tcpPendingRef.current || gripperTargetRef.current !== undefined)) handleDragCancel(); };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [handleDragCancel]);
  useEffect(() => { if (tcpPendingRef.current || gripperTargetRef.current !== undefined) handleDragCancel(); }, [xml, bridge, tcp.name]);

  const modelError = model instanceof Error ? model.message : "";
  const overlayError = error || modelError || tcp.error;
  const enabled = Boolean(active && !jointMotion?.busy && interaction === "tcp" && trajectoryController?.jointNames?.length && !trajectoryController.readinessError && tcp.name && robot && !overlayError);
  const rotationJoints = useMemo(() => rotationalJoints(model instanceof Error ? null : model).map((joint) =>
    joint.name === GRIPPER_JOINT_NAME && jointMotion?.gripper?.supported
      ? { ...joint, lower: Math.max(joint.lower, jointMotion.gripper.lower), upper: Math.min(joint.upper, jointMotion.gripper.upper) } : joint), [model, jointMotion?.gripper?.supported, jointMotion?.gripper?.lower, jointMotion?.gripper?.upper]);
  const rotationJoint = rotationJoints.find((joint) => joint.name === selectedJoint);
  const pickJoint = (event: ThreeEvent<MouseEvent>) => {
    if (!active || interaction !== "joint" || jointMotion?.busy || !model || model instanceof Error || event.delta > 4) return;
    const names: string[] = [];
    let object = event.object;
    while (object) { names.push(object.name); if (!object.parent) break; object = object.parent; }
    const name = pickedRotationJoint(model, names);
    if (name) { event.stopPropagation(); selectJoint(name); }
  };

  return (
    <div className={`viewer${interaction === "joint" ? " joint-mode" : ""}`}>
      <div className="viewer-layout" onContextMenu={event=>{if(!(event.target as Element).closest('.viewer-heads-up'))canvasMenu.onContextMenu(event);}}>
      {canvasMenu.menu}<div className="viewer-canvas-menu">{canvasMenu.trigger}</div>
      {!xml && <div className="viewer-placeholder">等待 URDF Topic 数据…</div>}
      <ViewerHeadsUp revealControls={revealControls} error={overlayError} leading={<MotionControlPanel info={motionInfo} />} rgbd={rgbdStatus?.enabled !== false && (
          <div className="viewer-overlay-rgbd" data-testid="rgbd-controls">
            {clockSync && <ClockSyncStatus value={clockSync} />}
            {visualPickSupported&&objectsEnabled&&<VisualPickPanel bridge={bridge} token={token} selected={selected} selectionRevision={selection?.revision} active={active&&objectsEnabled&&rgbdVisible&&visualPickSupported}
              motion={providedJointMotion} onPreview={setVisualPreview} onBusy={setVisualBusy} onClear={()=>{setSelection(null);setVisualPreview(null);}}/>}
            <ObjectDetectionControls supported={objectsSupported} enabled={objectsEnabled} onEnabledChange={onObjectsEnabledChange}
              frame={rgbdCloud?.objects} labels={objectLabels} dimensions={objectDimensions}
              onLabelsChange={setObjectLabels} onDimensionsChange={setObjectDimensions} />
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
              <details className="error"><summary>RGBD 暂不可用，查看错误详情</summary><div style={{ overflowWrap: "anywhere" }}>{rgbdStatus.tfError}</div></details>
            )}
            {!rgbdStatus?.pointCount && !rgbdStatus?.tfError && (
              <div className="viewer-overlay-row">等待 RGBD 帧；检查相机 Topic 和对齐深度</div>
            )}
          </div>
        )}>
        {loading && <div className="viewer-overlay-status" role="status">{loading}</div>}
        <div className="viewer-interaction" aria-label="Robot View 操作方式">
          <button type="button" aria-pressed={interaction === "tcp"} disabled={dragging} onClick={() => { previewJoint(null); handleDragCancel(); setInteraction("tcp"); }}>TCP 拖拽</button>
          <button type="button" aria-pressed={interaction === "joint"} disabled={dragging} onClick={() => { previewJoint(null); handleDragCancel(); setInteraction("joint"); }}>关节调整</button>
        </div>
        {interaction === "joint" && <JointRotationPanel joints={rotationJoints} selected={selectedJoint}
          jointState={jointState} active={active && Boolean(robot) && !overlayError} motion={jointMotion} hasPreview={Boolean(jointPreview)} resetKey={jointPreviewReset}
          onSelect={selectJoint} onPreview={previewJoint} />}
        {interaction === "tcp" && <>
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
                ? `拖拽中 · IK 误差 ${(preview.positionError * 1000).toFixed(1)} mm / ${(preview.orientationError * 180 / Math.PI).toFixed(2)}°`
                : "拖拽中…"
              : "拖动青色球快速定位，XYZ/RPY 微调；松手预览，确认执行"
            : trajectoryController
              ? trajectoryController.readinessError || "等待轨迹控制器关节反馈后可拖拽 TCP"
              : "轨迹控制器激活后可拖拽 TCP 下发轨迹"}
        </div>
        <TcpPosePanel pose={targetPose ?? actualPose} frame={handleFrame} frameId={model && !(model instanceof Error) ? model.rootLink : ""}
          disabled={!active || dragging || Boolean(jointMotion?.busy) || !robot} onFrame={setHandleFrame} onChange={solvePreview} onInputError={setPoseInputError} />
        {poseInputError && <p className="error" role="alert">{poseInputError}</p>}
        {preview && <p>位姿 IK：{(preview.positionError * 1000).toFixed(2)} mm / {(preview.orientationError * 180 / Math.PI).toFixed(2)}°</p>}
        <label>夹爪（joint7）单指行程 mm
          <input aria-label="TCP 夹爪行程 mm" type="number" step="0.1"
            min={(jointMotion?.gripper?.lower ?? 0) * 1000} max={(jointMotion?.gripper?.upper ?? 0) * 1000}
            disabled={!active || jointMotion?.busy || !jointMotion?.gripper?.available || !jointMotion.gripper.fresh}
            placeholder={jointMotion?.gripper?.position === undefined ? "保持当前" : `${(jointMotion.gripper.position * 1000).toFixed(2)}（保持当前）`}
            value={gripperText} onChange={(event) => { setGripperText(event.target.value); const value = event.target.value.trim() ? Number(event.target.value) / 1000 : undefined; if (value !== undefined && Number.isFinite(value)) robotRef.current?.setJointValue(GRIPPER_JOINT_NAME, value); else { gripperTargetRef.current = undefined; if (jointMotion?.gripper?.position !== undefined) robotRef.current?.setJointValue(GRIPPER_JOINT_NAME, jointMotion.gripper.position); } }} />
        </label>
        <input aria-label="TCP 夹爪行程滑块" type="range" step="0.1"
          min={(jointMotion?.gripper?.lower ?? 0) * 1000} max={(jointMotion?.gripper?.upper ?? 0) * 1000}
          value={Number.isFinite(gripperTarget) ? gripperTarget! * 1000 : (jointMotion?.gripper?.position ?? 0) * 1000}
          disabled={!active || jointMotion?.busy || !jointMotion?.gripper?.available || !jointMotion.gripper.fresh}
          onChange={(event) => { setGripperText(event.target.value); robotRef.current?.setJointValue(GRIPPER_JOINT_NAME, Number(event.target.value) / 1000); }} />
        {jointMotion?.gripper && !jointMotion.gripper.available && <p>{jointMotion.gripper.message}</p>}
        <label><input type="checkbox" checked={jointMotion?.armed ?? false} disabled={!jointMotion || jointMotion.busy}
          onChange={(event) => jointMotion?.setArmed(event.target.checked)} />已确认工作区安全，允许运动</label>
        <button type="button" disabled={!active || dragging || (!tcpPending && gripperTarget === undefined) || Boolean(preview?.error) || Boolean(poseInputError) || !jointMotion?.armed || jointMotion.busy || Boolean(tcpPending ? jointMotion.tcpPoseReason || !jointMotion.executeTcpPose : jointMotion.jointTargetsReason) || (gripperTarget !== undefined && (!Number.isFinite(gripperTarget) || !jointMotion.gripper?.available || !jointMotion.gripper.fresh || gripperTarget < jointMotion.gripper.lower || gripperTarget > jointMotion.gripper.upper))}
          onClick={() => void confirmTcp()}>确认执行</button>
        <button type="button" disabled={!tcpPending && gripperTarget === undefined} onClick={handleDragCancel}>恢复实时</button>
        {(jointMotion?.tcpPoseReason || !jointMotion?.executeTcpPose) && <p>{jointMotion?.tcpPoseReason || "当前 Bridge 不支持 TCP 位姿规划，请更新 Bridge"}</p>}
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
        {onSavePose && <div className="viewer-save-pose">
          <button type="button" className="position-primary" disabled={!active || dragging || Boolean(savePoseDisabledReason)}
            title={savePoseDisabledReason || "保存当前实测关节姿态，不保存未执行的 TCP 预览"} onClick={onSavePose}>保存当前姿态</button>
          {savePoseError && <p role="alert" className="error">{savePoseError}</p>}
        </div>}
        </>}

      </ViewerHeadsUp>
      <Canvas className="viewer-canvas" frameloop={active ? "always" : "never"} camera={{ position: [2, 2, 2], fov: 45 }} shadows>
        <color attach="background" args={["#08121d"]} />
        <Scene view={cameraView} showGrid={showGrid} showAxes={showAxes} robot={robot} controlsEnabled={active && !dragging} onPick={pickJoint}>
          {/* Cloud and robot share the scene root; cloud positions use the same ROS Z-up to scene Y-up rotation. */}
          <ObjectDetectionLayer frame={rgbdCloud?.objects} visible={active && rgbdVisible && objectsEnabled} labels={objectLabels} dimensions={objectDimensions} selectedId={selected?.id}
            onSelect={visualActive&&!visualBusy?(id)=>{const box=rgbdCloud?.objects?.items.find(b=>b.id===id);if(box)setSelection(previous=>({token,id,box,revision:(previous?.revision??0)+1}));providedJointMotion?.setArmed(false);}:undefined}/>
          <VisualPickPreviewLayer preview={visualActive&&selected?visualPreview:null}/>
          <RgbdPointCloudLayer
            cloud={rgbdCloud}
            visible={rgbdVisible}
            pointSize={rgbdPointSize}
            colorMode={rgbdColorMode}
            nearM={rgbdNearM}
            farM={rgbdFarM}
          />
          {active && interaction === "joint" && robot && rotationJoint && <JointAxisMarker robot={robot} joint={rotationJoint} />}
          {active && interaction === "tcp" && robot && tcp.name && (targetPose ?? actualPose) && (
            <TcpPoseHandle key={handleSession} pose={(targetPose ?? actualPose)!} frame={handleFrame}
              enabled={enabled} onDragStart={handleDragStart} onDragMove={handleDragMove}
              onDragEnd={handleDragEnd} onDragCancel={handleDragCancel} />
          )}
        </Scene>
      </Canvas>
      </div>
      {jointMotion && showMotionTerminal && <MotionTerminal logs={jointMotion.logs} active={active} plannerLog={plannerLog} />}
    </div>
  );
}
