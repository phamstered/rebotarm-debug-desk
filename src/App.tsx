import { DeployProgressLog } from "./DeployProgressLog";
import { appendDeployLog } from "./deployLogLogic";
import { ControlLogViewer } from "./ControlLogViewer";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { BridgeClient } from "./bridge";
import robotConsoleIcon from "./assets/robot-console-icon.png";
import { AppNav } from "./AppNav";
import { DataCollectionPage } from "./DataCollectionPage";
import type { AppPage } from "./AppNav";
import { Joint4CalibrationPage } from "./Joint4CalibrationPage";
import { GravityIdentificationPage } from "./GravityIdentificationPage";
import { MotorPage } from "./MotorPage";
import { MonitorPage } from "./MonitorPage";
import { PositionPage } from "./PositionPage";
import { usePositionMotion } from "./positionMotionLogic";
import { addPosition, captureCurrentArmPose, deletePosition, emptyPositionStore, profileKeyFor, updatePosition, type PositionDraft, type PositionStore } from "./positionLogic";
import { loadStoredPositions, saveStoredPositions } from "./positionStore";
import previewUrdf from "./testFixtures/rebotarm-kinematics.urdf?raw";
import { StatusPage } from "./StatusPage";
import { useArmModeWorkflow } from "./armModeWorkflowLogic";
import type { BridgeHelloInfo, StatusCardAction, StatusCardModel } from "./statusLogic";
import { formatHardwareMode, isFault11Latched } from "./statusLogic";
import { createCommandPayload } from "./motorLogic";
import { TopicInspector } from "./TopicInspector";
import { addFieldsToSeries } from "./dataGraphLogic";
import type { AgentServiceStatus, ArmModeStatus, BridgeEnvelope, ConnectionProfile, ControllerInfo, HardwareStatus, RemoteActionResult, RosbagPlayStatus, RosbagStatus, RosControlStatus, TopicInfo, UsbProbeStatus } from "./types";
import {
  addMonitorDashboard,
  addSeriesToDashboardPanel,
  clearDashboardPanels,
  deleteMonitorDashboard,
  loadMonitorWorkspace,
  removePanelFromDashboard,
  renameMonitorDashboard,
  resetDashboardPanelLayouts,
  saveMonitorWorkspace,
  selectMonitorDashboard,
  setMonitorCompactType,
  setMonitorLayoutLocked,
  updateDashboardLayout,
  updatePanelChart,
  updateMonitorFromMessage,
} from "./monitorLogic";
import type { MonitorWorkspace } from "./monitorLogic";
import { resolveMonitorSampleTimeMs } from "./monitorTimeline";
import { createTrajectoryPayload, findActiveTrajectoryController, isTrajectoryController, trajectoryJointNames, trajectoryStateTopic, TRAJECTORY_FEEDBACK_MAX_AGE_MS } from "./trajectoryLogic";
import { UrdfViewer } from "./UrdfViewer";
import type { RgbdColorMode } from "./RgbdPointCloud";
import {
  applyRgbdFrameToSession,
  createRgbdSessionState,
  parseRgbdFrameMeta,
  resetRgbdSession,
  type RgbdSessionState,
} from "./rgbdPointCloudLogic";
import type { TrajectorySendRequest } from "./UrdfViewer";
import {
  applyRecentHostToProfile,
  bridgeVersionBadgeLabel,
  bridgeVersionBadgeTone,
  checkBridgeVersion,
  CONNECT_STEPS,
  connectStepStatus,
  defaultPanelState,
  defaultSidebarState,
  deriveConnectStatusLights,
  domainMismatchHint,
  formatBridgeVersionLabel,
  formatConnectError,
  formatConnectHistoryLine,
  isAgentOnline,
  isRosReady,
  loadConnectHistory,
  loadLastKnownDomainId,
  loadNavigateStatusOnConnect,
  loadPanelState,
  loadProfile,
  loadRecentHosts,
  loadSidebarState,
  nextTopicSample,
  rememberConnectHistory,
  rememberLastKnownDomainId,
  rememberSuccessfulHost,
  saveNavigateStatusOnConnect,
} from "./appLogic";
import type { BridgeVersionCheck, CollapsiblePanel, ConnectHistory, ConnectStepId, PanelState, RecentHost, TopicSample } from "./appLogic";
import { clamp, defaultLayoutSizes, loadLayoutSizes, resizeColumn, resizeSplit } from "./layoutLogic";
import type { LayoutSizes } from "./layoutLogic";
import { buildDiagnosticsSnapshot, loadToolbarSettings } from "./toolbarLogic";
import type { ToolbarSettings } from "./toolbarLogic";
import {
  VLA_CHUNK_MESSAGE_TYPE,
  VLA_CHUNK_TOPIC,
  VLA_POSITION_CONTROLLER,
  isVlaControllerActive,
  vlaStartVerificationFailure,
} from "./vlaLogic";

type Stage = "idle" | "ssh" | "tunnel" | "bridge" | "upgrading" | "connected" | "failed";
const TopicGraph = lazy(() => import("./TopicGraph").then((module) => ({ default: module.TopicGraph })));
type CenterTab = "robot" | "graph" | "positions";

const stageNames: Record<Stage, string> = {
  idle: "未连接",
  ssh: "检查 SSH",
  tunnel: "建立会话",
  bridge: "连接 Bridge",
  upgrading: "升级 Bridge",
  connected: "已连接",
  failed: "连接失败",
};

const STATUS_LIGHT_LABELS = {
  ssh: "SSH",
  bridge: "Bridge",
  agent: "Agent",
  hardware: "HardwareStatus",
} as const;

function ConnectStatusStrip({
  lights,
  domainHint,
  rosReady,
  compact = false,
  versionCheck = null,
  onVersionClick,
  faultCode,
  faultMode,
  onFaultClick,
}: {
  lights: ReturnType<typeof deriveConnectStatusLights>;
  domainHint: string;
  rosReady?: boolean;
  compact?: boolean;
  versionCheck?: BridgeVersionCheck | null;
  onVersionClick?(): void;
  faultCode?: number | null;
  faultMode?: string | number | null;
  onFaultClick?(): void;
}) {
  const versionLabel = bridgeVersionBadgeLabel(versionCheck);
  const versionTone = bridgeVersionBadgeTone(versionCheck);
  const showFault = typeof faultCode === "number" && Number.isFinite(faultCode) && faultCode !== 0;
  const faultTitle = showFault
    ? `fault_code=${faultCode}${faultMode != null && faultMode !== "" ? ` · mode=${faultMode}` : ""} · 点击查看 Status Hardware`
    : "";
  return (
    <div className={`connect-status-strip ${compact ? "compact" : ""}`} role="group" aria-label="连接状态灯">
      {(Object.keys(STATUS_LIGHT_LABELS) as Array<keyof typeof STATUS_LIGHT_LABELS>).map((key) => (
        <span key={key} className={`status-light ${lights[key]}`} title={`${STATUS_LIGHT_LABELS[key]}：${lights[key]}`}>
          <i aria-hidden="true" />
          <span>{STATUS_LIGHT_LABELS[key]}{lights[key] === "ok" ? " OK" : lights[key] === "fail" ? " 失败" : lights[key] === "warn" ? " 异常" : lights[key] === "pending" ? "…" : ""}</span>
        </span>
      ))}
      {typeof rosReady === "boolean" && (
        <span className={`status-light ${rosReady ? "ok" : "pending"}`} title={rosReady ? "JointState 已收到，ROS 就绪" : "等待 JointState"}>
          <i aria-hidden="true" />
          <span>{rosReady ? "ROS 就绪" : "等待 JointState"}</span>
        </span>
      )}
      {versionLabel && (
        onVersionClick && versionCheck && versionCheck.status !== "match" ? (
          <button
            type="button"
            className={`status-light bridge-version-badge ${versionTone} clickable`}
            title={`${versionLabel} · 点击查看升级提示`}
            onClick={onVersionClick}
          >
            <i aria-hidden="true" />
            <span>{versionLabel}</span>
          </button>
        ) : (
          <span className={`status-light bridge-version-badge ${versionTone}`} title={versionLabel}>
            <i aria-hidden="true" />
            <span>{versionLabel}</span>
          </span>
        )
      )}
      {showFault && (
        onFaultClick ? (
          <button
            type="button"
            className="status-light fault-chip fail clickable"
            title={faultTitle}
            onClick={onFaultClick}
          >
            <i aria-hidden="true" />
            <span>Fault {faultCode}{faultMode != null && faultMode !== "" ? ` · mode ${faultMode}` : ""}</span>
          </button>
        ) : (
          <span className="status-light fault-chip fail" title={faultTitle}>
            <i aria-hidden="true" />
            <span>Fault {faultCode}</span>
          </span>
        )
      )}
      {domainHint && <span className="domain-hint" title={domainHint}>⚠ {domainHint}</span>}
    </div>
  );
}

function ConnectStepProgress({
  stage,
  failedStep,
  agentChecked,
}: {
  stage: Stage;
  failedStep: ConnectStepId | null;
  agentChecked: boolean;
}) {
  return (
    <ol className="connect-step-progress" aria-label="连接步骤">
      {CONNECT_STEPS.map((step, index) => {
        const status = connectStepStatus(step.id, stage, failedStep, agentChecked);
        return (
          <li key={step.id} className={`connect-step ${status}`} aria-current={status === "current" ? "step" : undefined}>
            <span className="connect-step-index">{index + 1}</span>
            <span className="connect-step-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PanelTitle({
  title,
  meta,
  expanded,
  onToggle,
  onRefresh,
  onCollapseSidebar,
  collapseSidebarLabel,
  refreshing = false,
  className = "",
}: {
  title: string;
  meta: string;
  expanded: boolean;
  onToggle(): void;
  onRefresh?(): void;
  onCollapseSidebar?(): void;
  collapseSidebarLabel?: string;
  refreshing?: boolean;
  className?: string;
}) {
  return (
    <div className={`panel-title ${className}`}>
      <strong>{title}</strong>
      <div className="panel-title-actions">
        <span className="panel-meta">{meta}</span>
        {onCollapseSidebar && <button className="sidebar-rail-toggle" type="button" aria-label={collapseSidebarLabel} title={collapseSidebarLabel} onClick={onCollapseSidebar}>{collapseSidebarLabel === "收起右侧栏" ? "›" : "‹"}</button>}
        {onRefresh && (
          <button
            className={`panel-refresh ${refreshing ? "refreshing" : ""}`}
            type="button"
            aria-label={`刷新${title}`}
            title={`刷新 ${title}`}
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <span>↻</span>
          </button>
        )}
        <button
          className="panel-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"}${title}`}
          title={`${expanded ? "收起" : "展开"} ${title}`}
          onClick={onToggle}
        >
          {expanded ? "−" : "+"}
        </button>
      </div>
    </div>
  );
}

function ResizeHandle({
  orientation,
  label,
  value,
  minimum = 0,
  maximum = 100,
  className,
  onPointerDown,
  onKeyDown,
}: {
  orientation: "horizontal" | "vertical";
  label: string;
  value: number;
  minimum?: number;
  maximum?: number;
  className: string;
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
}) {
  return (
    <div
      className={`resize-handle ${className}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(value)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

function ModalShell({ title, onClose, children, actions }: { title: string; onClose(): void; children: ReactNode; actions: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <section className="toolbar-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="toolbar-modal-title"><strong>{title}</strong><button type="button" aria-label={`关闭${title}`} onClick={onClose}>×</button></div>
        <div className="toolbar-modal-content">{children}</div>
        <div className="toolbar-modal-actions">{actions}</div>
      </section>
    </div>
  );
}

function ProfileForm({ profile, onChange }: { profile: ConnectionProfile; onChange(profile: ConnectionProfile): void }) {
  const field = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) =>
    onChange({ ...profile, [key]: value });
  return (
    <div className="profile-form">
      <div className="profile-grid">
        <label>SSH 主机<input value={profile.host} onChange={(e) => field("host", e.target.value)} placeholder="jetson 或 user@192.168.x.x" /></label>
        <label>SSH 用户名<input value={profile.username} onChange={(e) => field("username", e.target.value)} placeholder="使用 ~/.ssh/config" /></label>
        <label>SSH 端口<input type="number" value={profile.sshPort} onChange={(e) => field("sshPort", Number(e.target.value))} /></label>
        <label>私钥路径<input value={profile.identityFile} onChange={(e) => field("identityFile", e.target.value)} placeholder="使用 SSH Agent / config" /></label>
      </div>
      <details className="profile-advanced">
        <summary>高级</summary>
        <div className="profile-grid profile-advanced-grid">
          <label>ROS_DOMAIN_ID<input type="number" value={profile.rosDomainId} onChange={(e) => field("rosDomainId", Number(e.target.value))} /></label>
          <label>ROS 环境脚本<input value={profile.rosSetupScript} onChange={(e) => field("rosSetupScript", e.target.value)} placeholder="/path/to/install/setup.bash" /></label>
          <label>RGBD 启用<input type="checkbox" checked={profile.rgbdEnabled} onChange={(e) => field("rgbdEnabled", e.target.checked)} /></label>
          <label>RGB Topic<input value={profile.rgbdRgbTopic} onChange={(e) => field("rgbdRgbTopic", e.target.value)} placeholder="/cameras/left_arm/wrist/color/image_raw" /></label>
          <label>Depth Topic<input value={profile.rgbdDepthTopic} onChange={(e) => field("rgbdDepthTopic", e.target.value)} placeholder="/cameras/left_arm/wrist/aligned_depth_to_color/image_raw" /></label>
          <label>CameraInfo Topic<input value={profile.rgbdCameraInfoTopic} onChange={(e) => field("rgbdCameraInfoTopic", e.target.value)} placeholder="/cameras/left_arm/wrist/color/camera_info" /></label>
          <label>RGBD 目标 TF<input value={profile.rgbdTargetFrame} onChange={(e) => field("rgbdTargetFrame", e.target.value)} placeholder="base_link" /></label>
          <label>RGBD 最大宽<input type="number" value={profile.rgbdMaxWidth} onChange={(e) => field("rgbdMaxWidth", Number(e.target.value))} /></label>
          <label>RGBD 最大高<input type="number" value={profile.rgbdMaxHeight} onChange={(e) => field("rgbdMaxHeight", Number(e.target.value))} /></label>
          <label>RGBD 最大 FPS<input type="number" value={profile.rgbdMaxFps} onChange={(e) => field("rgbdMaxFps", Number(e.target.value))} /></label>
        </div>
      </details>
    </div>
  );
}

export default function App() {
  const [appPage, setAppPage] = useState<AppPage>(() => {
    const saved = localStorage.getItem("robot-console-page");
    return saved === "status" || saved === "motor" || saved === "calibration" || saved === "gravity" || saved === "monitor" || saved === "collection" ? saved : "dashboard";
  });
  const [navExpanded, setNavExpanded] = useState(() => localStorage.getItem("robot-console-nav-expanded") !== "false");
  const [profile, setProfile] = useState(loadProfile);
  const [stage, setStage] = useState<Stage>("idle");
  const [failedStep, setFailedStep] = useState<ConnectStepId | null>(null);
  const [sshOk, setSshOk] = useState(false);
  const [bridgeUp, setBridgeUp] = useState(false);
  const [agentChecked, setAgentChecked] = useState(false);
  const [error, setError] = useState("");
  const [errorCopied, setErrorCopied] = useState(false);
  const [recentHosts, setRecentHosts] = useState<RecentHost[]>(() => loadRecentHosts());
  const [bridgeVersionCheck, setBridgeVersionCheck] = useState<BridgeVersionCheck | null>(null);
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);
  const [deployProgress, setDeployProgress] = useState<string[]>([]);
  const [lastKnownDomainId, setLastKnownDomainId] = useState<number | null>(() => loadLastKnownDomainId());
  const [navigateStatusOnConnect, setNavigateStatusOnConnect] = useState(() => loadNavigateStatusOnConnect());
  const [connectHistory, setConnectHistory] = useState<ConnectHistory | null>(() => loadConnectHistory());
  const [statusHighlightCardId, setStatusHighlightCardId] = useState<string | null>(null);
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [topicFilter, setTopicFilter] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState("");
  const [topicSubscribeError, setTopicSubscribeError] = useState("");
  const [messages, setMessages] = useState<Record<string, TopicSample>>({});
  const [positionStore, setPositionStore] = useState<PositionStore>(() => emptyPositionStore());
  const [urdf, setUrdf] = useState("");
  const [jointState, setJointState] = useState<{ name?: string[]; position?: number[] } | null>(null);
  const [rgbdSession, setRgbdSession] = useState<RgbdSessionState>(() => createRgbdSessionState());
  const [rgbdColorMode, setRgbdColorMode] = useState<RgbdColorMode>("rgb");
  const rgbdInterestRef = useRef(false);
  const rgbdSubscribeKeyRef = useRef("");

  const [hardwareStatus, setHardwareStatus] = useState<HardwareStatus | null>(null);
  const hardwareStatusRef = useRef<HardwareStatus | null>(null);
  useEffect(() => { hardwareStatusRef.current = hardwareStatus; }, [hardwareStatus]);
  const [bridgeHello, setBridgeHello] = useState<BridgeHelloInfo | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentServiceStatus | null>(null);
  const [agentError, setAgentError] = useState("");
  const [usbProbe, setUsbProbe] = useState<UsbProbeStatus | null>(null);
  const [usbChecked, setUsbChecked] = useState(false);
  const [armMode, setArmMode] = useState<ArmModeStatus | null>(null);
  const [statusActionBusy, setStatusActionBusy] = useState<string | null>(null);
  const [statusActionNotice, setStatusActionNotice] = useState("");
  const [rosControl, setRosControl] = useState<RosControlStatus | null>(null);
  const [trajectoryStateError, setTrajectoryStateError] = useState("");
  const [topicRefreshing, setTopicRefreshing] = useState(false);
  const [topicRefreshError, setTopicRefreshError] = useState("");
  const [rosControlRefreshing, setRosControlRefreshing] = useState(false);
  const [controllerAction, setControllerAction] = useState<{ name: string; action: "activate" | "deactivate" } | null>(null);
  const [controllerActionMessage, setControllerActionMessage] = useState("");
  const [controllerActionError, setControllerActionError] = useState("");
  const [gravitySessionActive, setGravitySessionActive] = useState(false);
  const [controlStreaming, setControlStreaming] = useState(false);
  const [effectiveLocalPort, setEffectiveLocalPort] = useState<number | null>(null);
  const [centerTab, setCenterTab] = useState<CenterTab>("robot");
  const [managePositions, setManagePositions] = useState(false);
  const [topicsVisited, setTopicsVisited] = useState(false);
  const [robotVisited, setRobotVisited] = useState(false);
  const [windowVisible, setWindowVisible] = useState(!document.hidden);
  const [inspectorDataVisible, setInspectorDataVisible] = useState(true);
  const [imageSubscriptionRevision, setImageSubscriptionRevision] = useState(0);
  const [monitorWorkspace, setMonitorWorkspace] = useState<MonitorWorkspace>(() =>
    loadMonitorWorkspace(loadProfile().jointStateTopic),
  );
  const [rosbagPlayStatus, setRosbagPlayStatus] = useState<RosbagPlayStatus | null>(null);
  const [bagBusy, setBagBusy] = useState(false);
  const [bagNotice, setBagNotice] = useState("");
  const [bagClockMs, setBagClockMs] = useState<number | null>(null);
  const [bagOriginMs, setBagOriginMs] = useState<number | null>(null);
  const [bagWallStartedAtMs, setBagWallStartedAtMs] = useState<number | null>(null);
  const bagPlayingRef = useRef(false);
  const bagClockMsRef = useRef<number | null>(null);
  const [panels, setPanels] = useState<PanelState>(loadPanelState);
  const [sidebars, setSidebars] = useState(loadSidebarState);
  const [focusController, setFocusController] = useState("");
  const [layout, setLayout] = useState<LayoutSizes>(loadLayoutSizes);
  const [liveUpdates, setLiveUpdates] = useState(true);
  const [rosbagStatus, setRosbagStatus] = useState<RosbagStatus | null>(null);
  const [toolbarBusy, setToolbarBusy] = useState<"record" | "diagnostics" | "">("");
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [profileDraft, setProfileDraft] = useState<ConnectionProfile>(profile);
  const [pendingProfile, setPendingProfile] = useState<ConnectionProfile | null>(null);
  const [settings, setSettings] = useState<ToolbarSettings>(loadToolbarSettings);
  const [settingsDraft, setSettingsDraft] = useState<ToolbarSettings>(settings);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const topicSidebarRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const connectionGenerationRef = useRef(0);
  const topicRefreshInFlightRef = useRef(false);
  const rosControlRefreshInFlightRef = useRef(false);
  const liveUpdatesRef = useRef(true);
  const bridge = useMemo(() => new BridgeClient(), []);
  const filteredTopics = useMemo(() => {
    const query = topicFilter.trim().toLocaleLowerCase();
    if (!query) return topics;
    return topics.filter((topic) =>
      topic.name.toLocaleLowerCase().includes(query)
      || topic.types.some((type) => type.toLocaleLowerCase().includes(query)),
    );
  }, [topicFilter, topics]);
  const selectedTopicType = useMemo(
    () => topics.find((topic) => topic.name === selected)?.types[0] ?? "",
    [selected, topics],
  );
  const imageTopicNamesRef = useRef(new Set<string>());
  imageTopicNamesRef.current = new Set(topics.filter((topic) => topic.types[0] === "sensor_msgs/msg/Image").map((topic) => topic.name));
  const imageInterestRef = useRef("");
  imageInterestRef.current = stage === "connected" && appPage === "dashboard" && windowVisible && liveUpdates
    && panels.inspector && sidebars.right && inspectorDataVisible && !selectedNode && selectedTopicType === "sensor_msgs/msg/Image" ? selected : "";
  useEffect(() => {
    if (stage === "connected" && appPage === "dashboard") {
      setTopicsVisited(true);
      if (centerTab === "robot") setRobotVisited(true);
    }
  }, [stage, appPage, centerTab]);
  useEffect(() => {
    const changed = () => setWindowVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    if (stage !== "connected" || appPage !== "dashboard" || !windowVisible || !liveUpdates || !panels.inspector || !sidebars.right || !inspectorDataVisible || selectedNode || selectedTopicType !== "sensor_msgs/msg/Image") return;
    let disposed = false;
    const generation = connectionGenerationRef.current;
    void bridge.request({ op: "subscribe", topic: selected, type: selectedTopicType }).catch((reason: unknown) => {
      if (!disposed && generation === connectionGenerationRef.current) setTopicSubscribeError(String(reason));
    });
    return () => {
      disposed = true;
      // A legacy Bridge may not implement unsubscribe; its build-id prompt still offers upgrade.
      void bridge.request({ op: "unsubscribe", topic: selected }).catch(() => {});
      setMessages((current) => { const next = { ...current }; delete next[selected]; return next; });
    };
  }, [bridge, stage, appPage, windowVisible, liveUpdates, panels.inspector, sidebars.right, inspectorDataVisible, selected, selectedNode, selectedTopicType, imageSubscriptionRevision]);

  // RGBD 点云：独立 subscribe_rgbd，不与 Inspector Image 兴趣集合共享；隐藏/不可见时释放。
  // Bridge 支持 replace-on-resubscribe：已订阅时 topic/max/target_frame 变化也要重发。
  useEffect(() => {
    const want =
      stage === "connected" &&
      appPage === "dashboard" &&
      centerTab === "robot" &&
      windowVisible &&
      liveUpdates &&
      profile.rgbdEnabled;
    const subscribeKey = want
      ? [
          profile.rgbdRgbTopic,
          profile.rgbdDepthTopic,
          profile.rgbdCameraInfoTopic,
          profile.rgbdTargetFrame,
          String(profile.rgbdMaxWidth),
          String(profile.rgbdMaxHeight),
          String(profile.rgbdMaxFps),
        ].join("\0")
      : "";
    if (want === rgbdInterestRef.current && subscribeKey === rgbdSubscribeKeyRef.current) return;
    rgbdInterestRef.current = want;
    rgbdSubscribeKeyRef.current = subscribeKey;
    if (want) {
      bridge.send({
        op: "subscribe_rgbd",
        rgb_topic: profile.rgbdRgbTopic,
        depth_topic: profile.rgbdDepthTopic,
        camera_info_topic: profile.rgbdCameraInfoTopic,
        target_frame: profile.rgbdTargetFrame,
        max_width: profile.rgbdMaxWidth,
        max_height: profile.rgbdMaxHeight,
        max_fps: profile.rgbdMaxFps,
      });
    } else {
      bridge.send({ op: "unsubscribe_rgbd" });
    }
  }, [
    bridge, stage, appPage, centerTab, windowVisible, liveUpdates,
    profile.rgbdEnabled, profile.rgbdRgbTopic, profile.rgbdDepthTopic,
    profile.rgbdCameraInfoTopic, profile.rgbdTargetFrame,
    profile.rgbdMaxWidth, profile.rgbdMaxHeight, profile.rgbdMaxFps,
  ]);

  // 只有 active 的轨迹控制器才允许在 Robot View 拖拽 TCP 并下发轨迹。
  const activeTrajectoryController = useMemo(
    () => findActiveTrajectoryController(rosControl?.controllers ?? []),
    [rosControl],
  );
  const controllerStateTopic = activeTrajectoryController ? trajectoryStateTopic(activeTrajectoryController, topics) : "";
  const controllerStateSample = messages[controllerStateTopic];
  const controllerJointNames = trajectoryJointNames(controllerStateSample?.data);
  const trajectoryController = activeTrajectoryController ? {
    ...activeTrajectoryController,
    jointNames: controllerJointNames ?? undefined,
    readinessError: trajectoryStateError || (controllerStateSample && !controllerJointNames ? "控制器反馈关节列表无效" : ""),
  } : null;

  useEffect(() => {
    setTrajectoryStateError("");
    if (stage !== "connected" || !controllerStateTopic) return;
    let disposed = false;
    void bridge.request({ op: "subscribe", topic: controllerStateTopic, type: "control_msgs/msg/JointTrajectoryControllerState" }).catch((reason: unknown) => {
      if (!disposed) setTrajectoryStateError(`无法读取轨迹控制器反馈：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => { disposed = true; };
  }, [bridge, stage, controllerStateTopic]);

  const sendTrajectory = useCallback(async (request: TrajectorySendRequest) => {
    const controller = activeTrajectoryController;
    if (!controller) throw new Error("没有激活的轨迹控制器");
    if (!liveUpdatesRef.current) throw new Error("实时显示已暂停，请恢复后再下发轨迹");
    const now = performance.now();
    const fresh = (at?: number) => at != null && now - at >= 0 && now - at < TRAJECTORY_FEEDBACK_MAX_AGE_MS;
    if (!fresh(messages[profile.jointStateTopic]?.lastAt)) throw new Error("JointState 反馈缺失或已过期，未下发轨迹");
    if (!fresh(controllerStateSample?.lastAt)) throw new Error("轨迹控制器反馈缺失或已过期，未下发轨迹");
    const names = trajectoryJointNames(controllerStateSample.data);
    if (!names || names.length !== request.jointNames.length || names.some((name, index) => name !== request.jointNames[index])) {
      throw new Error("轨迹关节列表与当前控制器不匹配，请重新拖拽规划");
    }
    await bridge.request({
      ...createTrajectoryPayload(request.jointNames, request.points),
      topic: controller.topic,
    }, 30_000);
  }, [bridge, activeTrajectoryController, controllerStateSample, messages, profile.jointStateTopic]);

  const addToMonitor = useCallback((fieldPath: string, dashboardId: string, panelId: string | null) => {
    if (!selected) return;
    const sample = messages[selected];
    if (!sample) return;
    setMonitorWorkspace((current) => {
      const dashboard = current.dashboards.find((entry) => entry.id === dashboardId);
      if (!dashboard) return current;
      const series = addFieldsToSeries([], selected, fieldPath, sample.data);
      return addSeriesToDashboardPanel(current, dashboard.id, panelId, series);
    });
    setAppPage("monitor");
  }, [messages, selected]);

  useEffect(() => {
    localStorage.setItem("easy-debug-panels", JSON.stringify(panels));
  }, [panels]);

  useEffect(() => {
    localStorage.setItem("easy-debug-sidebars", JSON.stringify(sidebars));
  }, [sidebars]);

  useEffect(() => {
    localStorage.setItem("easy-debug-layout", JSON.stringify(layout));
  }, [layout]);

  useEffect(() => {
    localStorage.setItem("robot-console-page", appPage);
  }, [appPage]);

  useEffect(() => {
    saveMonitorWorkspace(monitorWorkspace);
  }, [monitorWorkspace]);

  useEffect(() => {
    localStorage.setItem("robot-console-nav-expanded", String(navExpanded));
  }, [navExpanded]);

  useEffect(() => {
    let cancelled = false;
    void loadStoredPositions().then((store) => {
      if (!cancelled) setPositionStore(store);
    });
    return () => { cancelled = true; };
  }, []);

  const positionProfileKey = profileKeyFor(profile);
  const positionMotion = usePositionMotion(bridge, stage === "connected", positionProfileKey,
    statusActionBusy ? "控制模式操作进行中，请等待完成" : !liveUpdates ? "实时显示已暂停，请恢复后执行" : controlStreaming || gravitySessionActive ? "其他控制任务正在运行，请先停止" :
      activeTrajectoryController?.name.replace(/^\//, "") !== "arm_trajectory_controller" ? "请先激活 arm_trajectory_controller 轨迹控制" : "");
  const captureSamples = [
    {
      topic: profile.jointStateTopic,
      state: jointState,
      receivedAt: messages[profile.jointStateTopic]?.lastAt ?? null,
    },
  ];
  if (profile.jointStateTopic !== "/joint_states") {
    const sample = messages["/joint_states"];
    const data = sample?.data;
    captureSamples.push({
      topic: "/joint_states",
      state: data && typeof data === "object" ? data as { name?: string[]; position?: number[] } : null,
      receivedAt: sample?.lastAt ?? null,
    });
  }
  const captureError = (() => {
    const captured = captureCurrentArmPose(captureSamples, performance.now(), profile.jointStateTopic);
    return "error" in captured ? captured.error : "";
  })();

  function capturePose() {
    return captureCurrentArmPose(captureSamples, performance.now(), profile.jointStateTopic);
  }

  function persistPositions(next: PositionStore) {
    setPositionStore(next);
    void saveStoredPositions(next).catch(() => undefined);
  }

  function createPosition(draft: PositionDraft) {
    const result = addPosition(positionStore, positionProfileKey, draft, Date.now(), crypto.randomUUID());
    if (!result.error) persistPositions(result.store);
    return result.error;
  }

  function editPosition(id: string, draft: PositionDraft) {
    const result = updatePosition(positionStore, positionProfileKey, id, draft, Date.now());
    if (!result.error) persistPositions(result.store);
    return result.error;
  }

  function removePosition(id: string) {
    const result = deletePosition(positionStore, positionProfileKey, id);
    if (!result.error) persistPositions(result.store);
  }

  useEffect(() => {
    saveNavigateStatusOnConnect(navigateStatusOnConnect);
  }, [navigateStatusOnConnect]);

  useEffect(() => {
    if (!statusHighlightCardId) return;
    const timer = window.setTimeout(() => setStatusHighlightCardId(null), 4500);
    return () => window.clearTimeout(timer);
  }, [statusHighlightCardId]);

  useEffect(() => {
    liveUpdatesRef.current = liveUpdates;
  }, [liveUpdates]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const togglePanel = (panel: CollapsiblePanel) => {
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  const beginResize = (
    cursor: "col-resize" | "row-resize",
    onMove: (event: PointerEvent) => void,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    dragCleanupRef.current?.();
    document.body.classList.add("resizing-panels");
    document.body.style.cursor = cursor;
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("resizing-panels");
      document.body.style.removeProperty("cursor");
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const beginColumnResize = (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => {
    beginResize("col-resize", (pointer) => {
      setLayout((current) => resizeColumn(side, pointer.clientX, window.innerWidth, current));
    }, event);
  };

  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = topicSidebarRef.current;
    if (!container) return;
    beginResize("row-resize", (pointer) => {
      const bounds = container.getBoundingClientRect();
      const ratio = resizeSplit(pointer.clientY, bounds.top, bounds.height);
      setLayout((current) => ({ ...current, leftTopRatio: ratio }));
    }, event);
  };

  const nudgeColumn = (side: "left" | "right", delta: number) => {
    setLayout((current) => {
      const targetX = side === "left"
        ? current.leftWidth + delta
        : window.innerWidth - (current.rightWidth + delta);
      return resizeColumn(side, targetX, window.innerWidth, current);
    });
  };

  const nudgeSplit = (delta: number) => {
    setLayout((current) => ({ ...current, leftTopRatio: clamp(current.leftTopRatio + delta, 0.18, 0.82) }));
  };

  const layoutStyle = {
    "--left-width": `${sidebars.left ? layout.leftWidth : 30}px`,
    "--right-width": `${sidebars.right ? layout.rightWidth : 30}px`,
    "--left-top-size": `${Math.round(layout.leftTopRatio * 10_000) / 100}%`,
  } as CSSProperties;

  const refreshTopics = useCallback(async () => {
    if (topicRefreshInFlightRef.current) return;
    const generation = connectionGenerationRef.current;
    topicRefreshInFlightRef.current = true;
    setTopicRefreshing(true);
    try {
      const discovered = await bridge.listTopics();
      if (generation !== connectionGenerationRef.current) return;
      setTopics(discovered);
      setTopicRefreshError("");
    } catch (reason) {
      if (generation !== connectionGenerationRef.current) return;
      setTopicRefreshError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === connectionGenerationRef.current) {
        topicRefreshInFlightRef.current = false;
        setTopicRefreshing(false);
      }
    }
  }, [bridge]);

  const fetchRosControllers = useCallback(
    () => invoke<RosControlStatus>("check_ros_controllers", { profile }),
    [profile],
  );

  const refreshRosControllers = useCallback(async () => {
    if (rosControlRefreshInFlightRef.current) return;
    const generation = connectionGenerationRef.current;
    rosControlRefreshInFlightRef.current = true;
    setRosControlRefreshing(true);
    try {
      const status = await fetchRosControllers();
      if (generation !== connectionGenerationRef.current) return;
      setRosControl(status);
    } catch (reason) {
      if (generation !== connectionGenerationRef.current) return;
      setRosControl({
        manager: "/controller_manager",
        available: false,
        controllers: [],
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      if (generation === connectionGenerationRef.current) {
        rosControlRefreshInFlightRef.current = false;
        setRosControlRefreshing(false);
      }
    }
  }, [fetchRosControllers]);

  const switchController = async (controller: ControllerInfo, action: "activate" | "deactivate") => {
    if (controllerAction) return;
    const generation = connectionGenerationRef.current;
    setControllerAction({ name: controller.name, action });
    setControllerActionMessage("");
    setControllerActionError("");
    try {
      const message = await invoke<string>("switch_ros_controller", {
        profile,
        controllerName: controller.name,
        action,
      });
      if (generation === connectionGenerationRef.current) {
        setControllerActionMessage(message || `${controller.name} ${action} 完成`);
      }
    } catch (reason) {
      if (generation === connectionGenerationRef.current) {
        setControllerActionError(reason instanceof Error ? reason.message : String(reason));
      }
    }
    try {
      const status = await fetchRosControllers();
      if (generation === connectionGenerationRef.current) setRosControl(status);
    } catch (reason) {
      if (generation !== connectionGenerationRef.current) return;
      setControllerActionError((current) => {
        const refreshError = `列表刷新失败：${reason instanceof Error ? reason.message : String(reason)}`;
        return current ? `${current}；${refreshError}` : refreshError;
      });
    } finally {
      if (generation === connectionGenerationRef.current) setControllerAction(null);
    }
  };

  useEffect(() => {
    return bridge.onMessage((message: BridgeEnvelope) => {
      if (message.op === "topic_message" && message.topic) {
        if (!liveUpdatesRef.current) return;
        const data = message.data as { data_bytes?: unknown; encoding?: unknown; width?: unknown } | null;
        if ((imageTopicNamesRef.current.has(message.topic) || (data && typeof data === "object" && data.data_bytes != null)) && message.topic !== imageInterestRef.current) return;
        const wallNow = performance.now();
        const resolved = resolveMonitorSampleTimeMs({
          bagPlaying: bagPlayingRef.current,
          topic: message.topic,
          data: message.data,
          wallNowMs: wallNow,
          bagClockMs: bagClockMsRef.current,
        });
        if (bagPlayingRef.current) {
          bagClockMsRef.current = resolved.bagClockMs;
          if (resolved.bagClockMs != null) {
            setBagClockMs(resolved.bagClockMs);
            setBagOriginMs((origin) => origin ?? resolved.bagClockMs);
          }
        }
        const now = resolved.sampleMs;
        setMessages((current) => {
          const previous = current[message.topic!];
          return {
            ...current,
            [message.topic!]: nextTopicSample(previous, message.data, wallNow),
          };
        });
        setMonitorWorkspace((current) => updateMonitorFromMessage(current, message.topic!, message.data, now));
        if (message.topic === profile.urdfTopic && typeof message.data === "string") setUrdf(message.data);
        if (message.topic === profile.jointStateTopic && message.data && typeof message.data === "object") {
          setJointState(message.data as { name?: string[]; position?: number[] });
        }
        if (message.topic === profile.statusTopic && message.data && typeof message.data === "object") {
          setHardwareStatus(message.data as HardwareStatus);
        }
      }
      if (message.op === "hello") {
        setBridgeHello({
          bridgeVersion: message.bridge_version,
          bridgeBuildId: message.bridge_build_id,
          rosDistro: message.ros_distro,
        });
      }
      if (message.op === "rgbd_frame") {
        try {
          const meta = parseRgbdFrameMeta(message);
          if (!meta.tf_ok) {
            setRgbdSession((current) => ({
              ...current,
              stale: true,
              tfOk: false,
              tfError: meta.error || meta.tf_error || "TF 查询失败",
            }));
          } else {
            const payload = message.rgbd_payload ?? new Uint8Array();
            setRgbdSession((current) =>
              applyRgbdFrameToSession(current, current.sessionId, meta, payload, Date.now()),
            );
          }
        } catch (reason) {
          setRgbdSession((current) => ({
            ...current,
            stale: true,
            tfOk: false,
            tfError: reason instanceof Error ? reason.message : String(reason),
          }));
        }
      }
      if (message.op === "disconnected") {
        rgbdInterestRef.current = false;
        rgbdSubscribeKeyRef.current = "";
        setRgbdSession((current) => resetRgbdSession(current));
        setFailedStep("bridge");
        setBridgeUp(false);
        setError(formatConnectError("Bridge WebSocket 已断开", "bridge"));
        setStage("failed");
      }
    });
  }, [bridge, profile.jointStateTopic, profile.statusTopic, profile.urdfTopic]);

  useEffect(() => {
    if (stage !== "connected") return;
    let disposed = false;
    const refresh = async () => {
      try {
        const status = await invoke<AgentServiceStatus>("check_micro_ros_agent", { profile });
        if (!disposed) {
          setAgentStatus(status);
          setAgentError("");
          setAgentChecked(true);
        }
      } catch (reason) {
        if (!disposed) {
          setAgentStatus(null);
          setAgentError(reason instanceof Error ? reason.message : String(reason));
          setAgentChecked(true);
        }
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [profile, stage]);

  const refreshUsbAndArm = useCallback(async () => {
    if (stage !== "connected" && !sshOk) return;
    try {
      const usb = await invoke<UsbProbeStatus>("probe_jetson_usb", { profile });
      setUsbProbe(usb);
      setUsbChecked(true);
    } catch (reason) {
      setUsbProbe({
        mcuPresent: false,
        mcuVidPid: "",
        realsensePresent: false,
        realsenseLines: [],
        rawLsusb: "",
        error: reason instanceof Error ? reason.message : String(reason),
      });
      setUsbChecked(true);
    }
    try {
      setArmMode(await invoke<ArmModeStatus>("probe_arm_mode", { profile }));
    } catch {
      // keep previous arm mode on transient probe failure
    }
  }, [profile, stage, sshOk]);

  useEffect(() => {
    if (stage !== "connected") return;
    let disposed = false;
    const refresh = async () => {
      if (disposed) return;
      await refreshUsbAndArm();
    };
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refreshUsbAndArm, stage]);

  async function switchVlaControllers(activate: string[], deactivate: string[]) {
    const message = await invoke<string>("switch_ros_controllers", {
      profile,
      activate,
      deactivate,
    });
    return message;
  }

  const statusActionInFlightRef = useRef(false);
  const armWorkflow = useArmModeWorkflow(profile, stage === "connected");

  async function runVlaStart() {
    if (statusActionBusy || statusActionInFlightRef.current) return;
    const actionGeneration = connectionGenerationRef.current;
    if (isFault11Latched(hardwareStatus)) {
      setStatusActionNotice("需先安全回零/托住，再重启 STM32（无软恢复）");
      return;
    }
    statusActionInFlightRef.current = true;
    setStatusActionBusy("vla-start");
    setStatusActionNotice("");
    try {
      setStatusActionNotice("正在安全回零并清理旧模式，再初始化 VLA 控制环境…");
      const reset = await armWorkflow.run("vla");
      if (actionGeneration !== connectionGenerationRef.current) return;
      if (!reset.ok) throw new Error(`${reset.message}：${reset.detail || reset.exitCode}`);
      await refreshRosControllers();
      await refreshUsbAndArm();
      const verified = await fetchRosControllers();
      if (actionGeneration !== connectionGenerationRef.current) return;
      let latestHardware = hardwareStatusRef.current;
      if (latestHardware != null) {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          latestHardware = hardwareStatusRef.current;
          if (latestHardware && (latestHardware.mode_name?.toUpperCase() === "TRACK" || latestHardware.mode === 1)) break;
          await new Promise((resolve) => window.setTimeout(resolve, 150));
        }
        latestHardware = hardwareStatusRef.current;
      }
      const verifyFailure = vlaStartVerificationFailure(verified, latestHardware);
      if (actionGeneration !== connectionGenerationRef.current) return;
      if (verifyFailure) throw new Error(verifyFailure);
      const notice = reset.message || `已激活 ${VLA_POSITION_CONTROLLER}`;
      setStatusActionNotice(`已重新初始化控制环境；${notice}`);
    } catch (reason) {
      if (actionGeneration !== connectionGenerationRef.current) return;
      setStatusActionNotice(reason instanceof Error ? reason.message : String(reason));
      try { await refreshRosControllers(); } catch { /* ignore */ }
    } finally {
      if (actionGeneration === connectionGenerationRef.current) {
        statusActionInFlightRef.current = false;
        setStatusActionBusy(null);
      }
    }
  }

  async function runVlaStop(alsoStopArm = false, disable = false) {
    if (statusActionBusy || statusActionInFlightRef.current) return;
    const actionGeneration = connectionGenerationRef.current;
    statusActionInFlightRef.current = true;
    setStatusActionBusy(alsoStopArm ? "arm-stop" : "vla-stop");
    setStatusActionNotice("");
    try {
      if (alsoStopArm) {
        const stopResult = await armWorkflow.run(disable ? "disable-stop" : "stop");
        if (actionGeneration !== connectionGenerationRef.current) return;
        if (!stopResult.ok) throw new Error(`${stopResult.message}：${stopResult.detail || stopResult.exitCode}`);
      }
      if (alsoStopArm) {
        setStatusActionNotice(disable ? "输出已关闭，控制环境已退出" : "已回零并关闭输出，控制环境已退出");
      } else if (isVlaControllerActive(rosControl)) {
        try {
          const message = await switchVlaControllers([], [VLA_POSITION_CONTROLLER]);
          if (actionGeneration !== connectionGenerationRef.current) return;
          setStatusActionNotice((current) => {
            const vlaMsg = message || `已停用 ${VLA_POSITION_CONTROLLER}`;
            return current ? `${current}；${vlaMsg}` : vlaMsg;
          });
        } catch (reason) {
          if (actionGeneration !== connectionGenerationRef.current) return;
          // If VLA was not loaded, deactivation may fail — surface but continue.
          const err = reason instanceof Error ? reason.message : String(reason);
          setStatusActionNotice((current) => (current ? `${current}；VLA 停止：${err}` : `VLA 停止：${err}`));
        }
      } else if (!alsoStopArm) {
        setStatusActionNotice("VLA 未运行");
      } else {
        setStatusActionNotice((current) => current || "已停止 Teleop/Trajectory");
      }
      await refreshRosControllers();
      await refreshUsbAndArm();
    } catch (reason) {
      if (actionGeneration !== connectionGenerationRef.current) return;
      setStatusActionNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (actionGeneration === connectionGenerationRef.current) {
        statusActionInFlightRef.current = false;
        setStatusActionBusy(null);
      }
    }
  }

  async function runStatusRestart(actionId: string, mode: "teleop" | "trajectory" | "realsense" | "stop" | "agent" | "moveit") {
    if (statusActionBusy || statusActionInFlightRef.current) return;
    const actionGeneration = connectionGenerationRef.current;
    statusActionInFlightRef.current = true;
    setStatusActionBusy(actionId);
    setStatusActionNotice("");
    try {
      if (mode === "agent") {
        const result = await invoke<RemoteActionResult>("restart_micro_ros_agent", { profile });
        if (actionGeneration !== connectionGenerationRef.current) return;
        setStatusActionNotice(result.ok ? result.message : `${result.message}：${result.detail || result.exitCode}`);
        try {
          const agent = await invoke<AgentServiceStatus>("check_micro_ros_agent", { profile });
          if (actionGeneration !== connectionGenerationRef.current) return;
          setAgentStatus(agent);
          setAgentError("");
        } catch (reason) {
          if (actionGeneration !== connectionGenerationRef.current) return;
          setAgentStatus(null);
          setAgentError(reason instanceof Error ? reason.message : String(reason));
        }
        return;
      }
      if (mode === "teleop" || mode === "trajectory") {
        if (isFault11Latched(hardwareStatus)) {
          throw new Error("需先安全回零/托住，再重启 STM32（无软恢复）");
        }
        // Teleop/Trajectory use SSH safe_stop (fail closed); do not publish one-shot Bridge HOLD.
        // Native lifecycle safely stops the owning hardware before removing any controller.
        setStatusActionNotice("安全回零 → 清理旧进程 → 启动并核验目标模式…");
      }
      const result = await armWorkflow.run(mode);
      if (actionGeneration !== connectionGenerationRef.current) return;
      setStatusActionNotice(result.ok ? result.message : `${result.message}：${result.detail || result.exitCode}`);
      await refreshUsbAndArm();
      await refreshRosControllers();
    } catch (reason) {
      if (actionGeneration !== connectionGenerationRef.current) return;
      setStatusActionNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (actionGeneration === connectionGenerationRef.current) {
        statusActionInFlightRef.current = false;
        setStatusActionBusy(null);
      }
    }
  }

  function handleStatusCardAction(action: StatusCardAction, _card: StatusCardModel) {
    if (action.id === "usb-refresh") {
      setStatusActionNotice("正在刷新 USB / 运行态…");
      void refreshUsbAndArm().then(() => setStatusActionNotice("USB / 运行态已刷新"));
      return;
    }
    if (action.id === "agent-restart") {
      void runStatusRestart("agent-restart", "agent");
      return;
    }
    if (action.id === "teleop-restart") {
      void runStatusRestart("teleop-restart", "teleop");
      return;
    }
    if (action.id === "trajectory-restart") {
      void runStatusRestart("trajectory-restart", "trajectory");
      return;
    }
    if (action.id === "realsense-restart") {
      void runStatusRestart("realsense-restart", "realsense");
      return;
    }
    if (action.id === "vla-start") {
      void runVlaStart();
      return;
    }
    if (action.id === "vla-stop") {
      void runVlaStop(false);
    }
  }

  function handleStatusQuickAction(id: "teleop" | "trajectory" | "vla" | "stop" | "disable-stop") {
    if (id === "teleop") void runStatusRestart("teleop-restart", "teleop");
    else if (id === "trajectory") void runStatusRestart("trajectory-restart", "trajectory");
    else if (id === "vla") void runVlaStart();
    else void runVlaStop(true, id === "disable-stop");
  }

  useEffect(() => {
    if (stage !== "connected") return;
    const timer = window.setInterval(() => void refreshTopics(), settings.refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshTopics, settings.refreshIntervalSeconds, stage]);

  useEffect(() => {
    if (stage !== "connected") return;
    void refreshRosControllers();
    const timer = window.setInterval(() => void refreshRosControllers(), settings.refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [refreshRosControllers, settings.refreshIntervalSeconds, stage]);

  function clearConnectionData() {
    connectionGenerationRef.current += 1;
    setTopicsVisited(false);
    setRobotVisited(false);
    topicRefreshInFlightRef.current = false;
    rosControlRefreshInFlightRef.current = false;
    setSshOk(false);
    setBridgeUp(false);
    setAgentChecked(false);
    setFailedStep(null);
    setErrorCopied(false);
    setTopics([]);
    setTopicFilter("");
    setSelected("");
    setSelectedNode("");
    setTopicSubscribeError("");
    setMessages({});
    setUrdf("");
    setJointState(null);
    setHardwareStatus(null);
    setBridgeHello(null);
    setBridgeVersionCheck(null);
    setVersionDialogOpen(false);
    setDeployProgress([]);
    setAgentStatus(null);
    setAgentError("");
    setUsbProbe(null);
    setUsbChecked(false);
    setArmMode(null);
    statusActionInFlightRef.current = false;
    setStatusActionBusy(null);
    setStatusActionNotice("");
    setRosControl(null);
    setFocusController("");
    setTopicRefreshing(false);
    setTopicRefreshError("");
    setRosControlRefreshing(false);
    setControllerAction(null);
    setControllerActionMessage("");
    setControllerActionError("");
    setControlStreaming(false);
    setGravitySessionActive(false);
    setEffectiveLocalPort(null);
    setLiveUpdates(true);
    setRosbagStatus(null);
    setRosbagPlayStatus(null);
    setBagClockMs(null);
    setBagOriginMs(null);
    setBagWallStartedAtMs(null);
    bagPlayingRef.current = false;
    bagClockMsRef.current = null;
    setBagBusy(false);
    setBagNotice("");
    setToolbarBusy("");
    setToolbarNotice("");
    // Keep Monitor panel config; clear live points by reloading persisted configs without points.
    setMonitorWorkspace(loadMonitorWorkspace(profile.jointStateTopic));
  }

  async function connect() {
    clearConnectionData();
    setError("");
    setErrorCopied(false);
    setStatusHighlightCardId(null);
    localStorage.setItem("easy-debug-profile", JSON.stringify(profile));
    const startedAt = Date.now();
    let activeStep: ConnectStepId = "ssh";
    try {
      setStage("ssh");
      activeStep = "ssh";
      await invoke("check_ssh", { profile });
      setSshOk(true);
      setRecentHosts(rememberSuccessfulHost(profile));

      setStage("tunnel");
      activeStep = "session";
      const localPort = await invoke<number>("start_session", { profile });
      setEffectiveLocalPort(localPort);

      setStage("bridge");
      activeStep = "bridge";
      const hello = await bridge.connect({ ...profile, localPort });
      setBridgeUp(true);
      const versionCheck = checkBridgeVersion(hello);
      setBridgeVersionCheck(versionCheck);
      if (versionCheck.status === "mismatch") {
        setVersionDialogOpen(true);
      } else if (versionCheck.status === "unknown") {
        setToolbarNotice(
          `${versionCheck.message}：远端 ${formatBridgeVersionLabel(versionCheck.remote)}，本地期望 ${formatBridgeVersionLabel(versionCheck.local)}`,
        );
      }
      const discovered = await bridge.listTopics();
      setTopics(discovered);
      setTopicRefreshError("");
      bridge.send({ op: "subscribe", topic: profile.urdfTopic, type: "std_msgs/msg/String" });
      bridge.send({ op: "subscribe", topic: profile.jointStateTopic, type: "sensor_msgs/msg/JointState" });
      if (profile.jointStateTopic !== "/joint_states") {
        bridge.send({ op: "subscribe", topic: "/joint_states", type: "sensor_msgs/msg/JointState" });
      }
      bridge.send({ op: "subscribe", topic: profile.statusTopic, type: "microros_stm32h723_bridge/msg/HardwareStatus" });
      // VlaJointChunk (positions[]); Bridge runtime decode required for Hz/Monitor sampling.
      bridge.send({ op: "subscribe", topic: VLA_CHUNK_TOPIC, type: VLA_CHUNK_MESSAGE_TYPE });

      setStage("connected");
      activeStep = "agent";
      try {
        setAgentStatus(await invoke<AgentServiceStatus>("check_micro_ros_agent", { profile }));
        setAgentError("");
      } catch (reason) {
        setAgentStatus(null);
        setAgentError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setAgentChecked(true);
      }
      void invoke<UsbProbeStatus>("probe_jetson_usb", { profile })
        .then((usb) => { setUsbProbe(usb); setUsbChecked(true); })
        .catch((reason) => {
          setUsbProbe({
            mcuPresent: false,
            mcuVidPid: "",
            realsensePresent: false,
            realsenseLines: [],
            rawLsusb: "",
            error: reason instanceof Error ? reason.message : String(reason),
          });
          setUsbChecked(true);
        });
      void invoke<ArmModeStatus>("probe_arm_mode", { profile })
        .then(setArmMode)
        .catch(() => undefined);
      rememberLastKnownDomainId(profile.rosDomainId);
      setLastKnownDomainId(profile.rosDomainId);
      const successHistory = rememberConnectHistory({
        outcome: "success",
        host: profile.host,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      setConnectHistory(successHistory);
      if (navigateStatusOnConnect) {
        setAppPage("status");
      }

      void invoke<RosbagStatus>("get_rosbag_status", { profile })
        .then(setRosbagStatus)
        .catch((reason) => setToolbarNotice(`无法读取 rosbag 状态：${reason instanceof Error ? reason.message : String(reason)}`));
      void invoke<RosbagPlayStatus>("get_rosbag_play_status", { profile })
        .then(setRosbagPlayStatus)
        .catch(() => undefined);
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : String(reason);
      const formatted = formatConnectError(raw, activeStep);
      setFailedStep(activeStep);
      setError(formatted);
      setStage("failed");
      const failureHistory = rememberConnectHistory({
        outcome: "failure",
        host: profile.host,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        failedStep: activeStep,
        reason: formatted,
      });
      setConnectHistory(failureHistory);
      await invoke("stop_session").catch(() => undefined);
    }
  }

  function pickRecentHost(host: RecentHost) {
    setProfile((current) => applyRecentHostToProfile(current, host));
  }

  async function copyConnectError() {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error);
      setErrorCopied(true);
      window.setTimeout(() => setErrorCopied(false), 1600);
    } catch {
      setErrorCopied(false);
    }
  }

  async function upgradeBridge() {
    setVersionDialogOpen(false);
    setDeployProgress(["准备升级 Bridge…"]);
    setStage("upgrading");
    setError("");
    bridge.close();
    await invoke("stop_session").catch(() => undefined);
    let unlisten: (() => void) | undefined;
    let receiving = true;
    try {
      unlisten = await listen<string>("bridge-deploy-progress", (event) => {
        if (receiving) setDeployProgress((lines) => appendDeployLog(lines, event.payload));
      });
    } catch {
      // Browser / test environments without the event plugin still show stage text.
    }
    try {
      const result = await invoke<{ ok: boolean; message: string; log: string }>("deploy_bridge", { profile });
      receiving = false;
      setDeployProgress((lines) => appendDeployLog(lines, result.message || "Bridge 升级完成"));
      setToolbarNotice(result.message || "Bridge 已升级");
      await connect();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStage("failed");
      receiving = false;
      setDeployProgress((lines) => appendDeployLog(lines, `[error] ${reason instanceof Error ? reason.message : String(reason)}`));
    } finally {
      receiving = false;
      unlisten?.();
    }
  }

  function skipBridgeUpgrade() {
    setVersionDialogOpen(false);
    if (bridgeVersionCheck?.status === "mismatch") {
      setToolbarNotice(
        `已跳过 Bridge 升级：远端 ${formatBridgeVersionLabel(bridgeVersionCheck.remote)}，本地期望 ${formatBridgeVersionLabel(bridgeVersionCheck.local)}`,
      );
    }
  }

  async function disconnect() {
    if (controlStreaming) {
      await bridge.request({
        op: "joint_command", mode: 3, position: 0, velocity: 0, kp: 0, kd: 0, effort: 0,
      }).catch(() => undefined);
    }
    bridge.close();
    await invoke("stop_session").catch(() => undefined);
    clearConnectionData();
    if (pendingProfile) {
      setProfile(pendingProfile);
      setPendingProfile(null);
    }
    setStage("idle");
  }

  function openConnectionSettings() {
    setProfileDraft(pendingProfile ?? profile);
    setConnectionDialogOpen(true);
  }

  function saveConnectionSettings() {
    localStorage.setItem("easy-debug-profile", JSON.stringify(profileDraft));
    setPendingProfile(profileDraft);
    setConnectionDialogOpen(false);
    setToolbarNotice("连接配置已保存，将在下次重连时生效");
  }

  function openToolbarSettings() {
    setSettingsDraft(settings);
    setSettingsDialogOpen(true);
  }

  function saveToolbarSettings() {
    const next = {
      refreshIntervalSeconds: Math.min(300, Math.max(5, Math.round(settingsDraft.refreshIntervalSeconds || 30))),
      includeMessagePreviews: settingsDraft.includeMessagePreviews,
    };
    setSettings(next);
    localStorage.setItem("robot-console-toolbar-settings", JSON.stringify(next));
    setSettingsDialogOpen(false);
    setToolbarNotice(`设置已保存：每 ${next.refreshIntervalSeconds} 秒自动刷新`);
  }

  function resetWorkspaceLayout() {
    setLayout({ ...defaultLayoutSizes });
    setPanels({ ...defaultPanelState });
    setSidebars({ ...defaultSidebarState });
    setToolbarNotice("工作区布局已恢复默认值");
  }

  async function toggleRosbagRecording() {
    if (toolbarBusy) return;
    setToolbarBusy("record");
    setToolbarNotice("");
    try {
      const command = rosbagStatus?.recording ? "stop_rosbag_recording" : "start_rosbag_recording";
      const status = await invoke<RosbagStatus>(command, { profile });
      setRosbagStatus(status);
      setToolbarNotice(`${status.message}${status.outputPath ? `：${status.outputPath}` : ""}`);
    } catch (reason) {
      setToolbarNotice(`rosbag 操作失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setToolbarBusy("");
    }
  }


  async function refreshBagPlayStatus() {
    try {
      const status = await invoke<RosbagPlayStatus>("get_rosbag_play_status", { profile });
      setRosbagPlayStatus(status);
      setBagNotice(status.message);
      bagPlayingRef.current = Boolean(status.playing);
      if (!status.playing) {
        bagClockMsRef.current = null;
        setBagClockMs(null);
        setBagOriginMs(null);
        setBagWallStartedAtMs(null);
      } else if (bagWallStartedAtMs == null) {
        setBagWallStartedAtMs(performance.now());
      }
    } catch (reason) {
      setBagNotice(`无法读取 bag 回放状态：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  }

  async function startBagPlay(bagPath: string) {
    setBagBusy(true);
    setBagNotice("");
    try {
      const status = await invoke<RosbagPlayStatus>("start_rosbag_playback", { profile, bagPath });
      setRosbagPlayStatus(status);
      setBagNotice(status.message);
      bagPlayingRef.current = Boolean(status.playing);
      bagClockMsRef.current = null;
      setBagClockMs(null);
      setBagOriginMs(null);
      setBagWallStartedAtMs(status.playing ? performance.now() : null);
      if (status.playing) {
        try {
          await bridge.request({
            op: "subscribe",
            topic: "/clock",
            type: "rosgraph_msgs/msg/Clock",
          });
        } catch (reason) {
          setBagNotice(
            `${status.message}（/clock 订阅未成功：${reason instanceof Error ? reason.message : String(reason)}；将回退消息 stamp / 墙钟）`,
          );
        }
      }
    } catch (reason) {
      bagPlayingRef.current = false;
      setBagWallStartedAtMs(null);
      setBagNotice(`bag 回放失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBagBusy(false);
    }
  }

    async function stopBagPlay() {
    setBagBusy(true);
    setBagNotice("");
    try {
      const status = await invoke<RosbagPlayStatus>("stop_rosbag_playback", { profile });
      setRosbagPlayStatus(status);
      setBagNotice(status.message);
    } catch (reason) {
      setBagNotice(`停止 bag 回放失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      bagPlayingRef.current = false;
      bagClockMsRef.current = null;
      setBagClockMs(null);
      setBagOriginMs(null);
      setBagWallStartedAtMs(null);
      setBagBusy(false);
    }
  }

  async function saveDiagnostics() {
    if (toolbarBusy) return;
    const localPath = await save({
      title: "保存 Robot Console 诊断快照",
      defaultPath: `robot-console-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!localPath) return;
    setToolbarBusy("diagnostics");
    setToolbarNotice("");
    try {
      await invoke("save_diagnostics_snapshot", {
        localPath,
        content: buildDiagnosticsSnapshot({
          profile,
          topics,
          rosControl,
          agentStatus,
          agentError,
          hardwareStatus,
          selectedTopic: selected,
          messages,
          liveUpdates,
          includeMessagePreviews: settings.includeMessagePreviews,
        }),
      });
      setToolbarNotice(`诊断快照已保存：${localPath}`);
    } catch (reason) {
      setToolbarNotice(`诊断快照保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setToolbarBusy("");
    }
  }

  async function selectTopic(topic: TopicInfo) {
    const generation = connectionGenerationRef.current;
    setSelected(topic.name);
    setSelectedNode("");
    setFocusController("");
    setCenterTab("graph");
    setTopicSubscribeError("");
    if (!topic.types[0]) {
      setTopicSubscribeError("该 Topic 没有可用消息类型");
      return;
    }
    if (topic.types[0] === "sensor_msgs/msg/Image") { setImageSubscriptionRevision((current) => current + 1); return; }
    try {
      await bridge.request({ op: "subscribe", topic: topic.name, type: topic.types[0] });
    } catch (reason) {
      if (generation === connectionGenerationRef.current) {
        setTopicSubscribeError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }

  const statusLights = deriveConnectStatusLights({
    stage,
    failedStep,
    sshOk,
    bridgeUp: bridgeUp || stage === "connected",
    agentOnline: isAgentOnline(agentStatus),
    agentChecked,
    agentError,
    hardwareReceived: Boolean(hardwareStatus),
  });
  const domainHint = domainMismatchHint(profile.rosDomainId, lastKnownDomainId);
  const rosReady = isRosReady(jointState);
  const connectBusy = ["ssh", "tunnel", "bridge", "upgrading"].includes(stage);
  const historyLine = formatConnectHistoryLine(connectHistory);
  const faultCode = hardwareStatus?.fault_code;
  const faultModeLabel = hardwareStatus ? formatHardwareMode(hardwareStatus) : "";
  const faultMode = faultModeLabel && faultModeLabel !== "—" ? faultModeLabel : null;

  function openFaultOnStatus() {
    setAppPage("status");
    setStatusHighlightCardId("hardware");
  }

  function openVersionPrompt() {
    if (bridgeVersionCheck?.status === "mismatch") {
      setVersionDialogOpen(true);
    } else if (bridgeVersionCheck?.status === "unknown") {
      setToolbarNotice(
        `${bridgeVersionCheck.message}：远端 ${formatBridgeVersionLabel(bridgeVersionCheck.remote)}，本地期望 ${formatBridgeVersionLabel(bridgeVersionCheck.local)}`,
      );
    }
  }

  function handleConnectShellKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && error) {
      event.preventDefault();
      setError("");
      setErrorCopied(false);
      return;
    }
    if (event.key !== "Enter" || connectBusy || stage === "connected") return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "TEXTAREA" || target.tagName === "BUTTON" || target.isContentEditable)) return;
    if (target?.closest("details.profile-advanced") && !(target instanceof HTMLInputElement)) return;
    event.preventDefault();
    void connect();
  }

  const positionPlanner = {
    busy: statusActionBusy === "moveit-start",
    disabledReason: stage !== "connected" ? "请先连接 Jetson" : statusActionBusy ? "控制模式操作进行中" :
      positionMotion.busy ? "请等待点位运动结束或取消" : controlStreaming || gravitySessionActive ? "其他控制任务正在运行" :
      activeTrajectoryController?.name.replace(/^\//, "") !== "arm_trajectory_controller" ? "请先在 Status 启动 Trajectory 模式" : "",
    notice: armWorkflow.workflow?.mode === "moveit" ? statusActionNotice : "",
    workflow: ["moveit", "trajectory"].includes(armWorkflow.workflow?.mode ?? "") ? armWorkflow.workflow : null,
    start: () => { void runStatusRestart("moveit-start", "moveit"); },
  };

  if (stage !== "connected" && managePositions) {
    return (
      <main className="connect-shell">
        <PositionPage
          profileKey={positionProfileKey}
          store={positionStore}
          captureError={captureError}
          urdfXml={urdf || previewUrdf}
          onCreate={createPosition}
          onUpdate={editPosition}
          onDelete={removePosition}
          onCapture={capturePose}
          motion={positionMotion}
          planner={positionPlanner}
          onBack={() => setManagePositions(false)}
        />
      </main>
    );
  }

  if (stage !== "connected") {
    return (
      <main className="connect-shell" onKeyDown={handleConnectShellKeyDown}>
        <section className="connect-card">
          <div className="brand"><img className="brand-mark" src={robotConsoleIcon} alt="" /><div><h1>Robot Console</h1><p>ROS 2 机器人调试工作台</p></div></div>
          {historyLine && (
            <p className="connect-history" aria-label="上次连接记录" title={historyLine}>{historyLine}</p>
          )}
          {recentHosts.length > 0 && (
            <div className="recent-hosts" aria-label="最近主机">
              <span className="recent-hosts-label">最近主机</span>
              <div className="recent-hosts-list">
                {recentHosts.map((host) => (
                  <button
                    key={`${host.host}:${host.sshPort}:${host.username}`}
                    type="button"
                    className="recent-host-chip"
                    title={`${host.host}${host.username ? ` · ${host.username}` : ""} · 端口 ${host.sshPort}`}
                    onClick={() => pickRecentHost(host)}
                  >
                    {host.host}{host.username ? `@${host.username}` : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
          <ProfileForm profile={profile} onChange={setProfile} />
          {(stage !== "idle" || error) && (
            <ConnectStepProgress stage={stage} failedStep={failedStep} agentChecked={agentChecked} />
          )}
          <ConnectStatusStrip lights={statusLights} domainHint={domainHint} versionCheck={bridgeVersionCheck} />
          <div className="connect-actions">
            <span className={`status ${stage}`}>{stageNames[stage]}</span>
            <div className="connect-action-buttons">
              {stage === "failed" && (
                <button type="button" className="ghost retry-connect" onClick={() => void connect()} disabled={connectBusy} title="从检查 SSH 起重新连接（非整步断点续传）">
                  重试
                </button>
              )}
              <button type="button" onClick={() => void connect()} disabled={connectBusy}>连接 Jetson</button>
              <button type="button" className="ghost" onClick={() => setManagePositions(true)}>管理位置</button>
            </div>
          </div>
          {deployProgress.length > 0 && <DeployProgressLog lines={deployProgress} />}
          {error && (
            <div className="error-panel" role="alert">
              <pre className="error-box">{error}</pre>
              <div className="error-panel-actions">
                <button type="button" className="copy-error" onClick={() => void copyConnectError()}>
                  {errorCopied ? "已复制" : "复制错误"}
                </button>
                <button type="button" className="dismiss-error" onClick={() => { setError(""); setErrorCopied(false); }} title="Esc 也可关闭">
                  关闭
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    );
  }

  const calibrationControllerState = rosControl?.controllers
    .find((controller) => controller.name === "joint4_calibration_controller")?.state;

  return (
    <div className={`app-shell ${navExpanded ? "" : "nav-collapsed"}`}>
      <AppNav
        page={appPage}
        expanded={navExpanded}
        rosReady={rosReady}
        onSelect={(next) => {
          setAppPage(next);
          if (next !== "status") setStatusHighlightCardId(null);
        }}
        onToggle={() => setNavExpanded((current) => !current)}
      />
      {!navExpanded && <button className="nav-reopen" aria-label="展开主工具栏" onClick={() => setNavExpanded(true)}>›</button>}
      <div className="app-main-column">
      <header className="connected-topbar" role="banner" aria-label="已连接工具条">
        <button
          type="button"
          className="toolbar-action switch-host"
          aria-label="断开并重连…"
          onClick={() => void disconnect()}
          title="断开当前会话并返回连接页；不会保留本会话，可再选主机重连"
        >
          <span aria-hidden="true">⇄</span>断开并重连…
        </button>
        <button type="button" className="toolbar-action" aria-label="连接配置" onClick={openConnectionSettings} title="编辑 SSH 与 ROS 连接配置；重连后生效">
          <span aria-hidden="true">⌁</span>连接配置
        </button>
        <button type="button" className="toolbar-action" aria-label="设置" onClick={openToolbarSettings} title="配置自动刷新、诊断快照与连接后导航">
          <span aria-hidden="true">⚙</span>设置
        </button>
        {toolbarNotice && <output className="toolbar-notice" title={toolbarNotice}>{toolbarNotice}</output>}
        <ConnectStatusStrip
          lights={statusLights}
          domainHint={domainHint}
          rosReady={rosReady}
          compact
          versionCheck={bridgeVersionCheck}
          onVersionClick={openVersionPrompt}
          faultCode={typeof faultCode === "number" ? faultCode : null}
          faultMode={faultMode}
          onFaultClick={openFaultOnStatus}
        />
        <span className="toolbar-spacer" />
        <span className="connected-dot" />
        <span className="connected-host-name">{profile.name || profile.host}</span>
        <span className="tunnel-port" title="SSH 本地转发端口">localhost:{effectiveLocalPort ?? profile.localPort}</span>
        <span
          className={`agent-badge ${isAgentOnline(agentStatus) ? "running" : agentError ? "unknown" : "stopped"}`}
          title={agentError || (agentStatus ? `${agentStatus.description}\n${agentStatus.activeState}/${agentStatus.subState}\nPID ${agentStatus.mainPid}\n开机状态：${agentStatus.unitFileState}` : "正在检查 systemd 状态")}
        >
          <span /> micro-ROS Agent：{isAgentOnline(agentStatus) ? "运行中" : agentError ? "检查失败" : agentStatus ? "未运行" : "检查中"}
        </span>
        <button className="ghost disconnect-btn" onClick={() => void disconnect()} title="断开 SSH 隧道与 Bridge">断开</button>
      </header>
      <div className="app-page-content">
      {appPage === "status" ? (
        <StatusPage
          workflow={armWorkflow.workflow}
          stage={stage}
          sshOk={sshOk}
          bridgeUp={bridgeUp || stage === "connected"}
          localPort={effectiveLocalPort}
          profile={profile}
          hello={bridgeHello}
          agentStatus={agentStatus}
          agentError={agentError}
          agentChecked={agentChecked}
          hardwareStatus={hardwareStatus}
          jointState={jointState}
          jointStateSample={messages[profile.jointStateTopic]}
          rosControl={rosControl}
          lastKnownDomainId={lastKnownDomainId}
          highlightCardId={statusHighlightCardId}
          onClearHighlight={() => setStatusHighlightCardId(null)}
          usbProbe={usbProbe}
          usbChecked={usbChecked}
          armMode={armMode}
          realsenseTopicSample={messages[profile.rgbdRgbTopic]}
          vlaChunkSample={messages[VLA_CHUNK_TOPIC]}
          actionBusy={statusActionBusy}
          actionNotice={statusActionNotice}
          onCardAction={handleStatusCardAction}
          onQuickAction={handleStatusQuickAction}
        />
      ) : appPage === "collection" ? (
        <DataCollectionPage profile={profile} topics={topics} rosReady={rosReady} hardwareStatus={hardwareStatus} topicSamples={messages} />
      ) : appPage === "gravity" ? (
        <GravityIdentificationPage
          bridge={bridge}
          onNavigateCalibration={() => setAppPage("calibration")}
          onSessionActiveChange={setGravitySessionActive}
        />
      ) : appPage === "calibration" ? (
        <Joint4CalibrationPage
          profile={profile}
          bridge={bridge}
          controllerState={calibrationControllerState}
          onRefreshControllers={() => void refreshRosControllers()}
        />
      ) : appPage === "monitor" ? (
        <MonitorPage
          workspace={monitorWorkspace}
          jointStateTopic={profile.jointStateTopic}
          liveUpdates={liveUpdates}
          bagStatus={rosbagPlayStatus}
          bagBusy={bagBusy}
          bagNotice={bagNotice}
          bagClockMs={bagClockMs}
          bagOriginMs={bagOriginMs}
          bagWallStartedAtMs={bagWallStartedAtMs}
          onSelectDashboard={(dashboardId) => setMonitorWorkspace((current) => selectMonitorDashboard(current, dashboardId))}
          onAddDashboard={(dashboard) => setMonitorWorkspace((current) => addMonitorDashboard(current, dashboard))}
          onRenameDashboard={(dashboardId, name) => setMonitorWorkspace((current) => renameMonitorDashboard(current, dashboardId, name))}
          onDeleteDashboard={(dashboardId) => setMonitorWorkspace((current) => deleteMonitorDashboard(current, dashboardId, profile.jointStateTopic))}
          onLayoutChange={(dashboardId, layout) => setMonitorWorkspace((current) => updateDashboardLayout(current, dashboardId, layout))}
          onRemovePanel={(dashboardId, panelId) => setMonitorWorkspace((current) => removePanelFromDashboard(current, dashboardId, panelId))}
          onUpdatePanelChart={(dashboardId, panelId, chart) => setMonitorWorkspace((current) => updatePanelChart(current, dashboardId, panelId, chart))}
          onClearPanels={(dashboardId) => setMonitorWorkspace((current) => clearDashboardPanels(current, dashboardId))}
          onResetLayout={(dashboardId) => setMonitorWorkspace((current) => resetDashboardPanelLayouts(current, dashboardId))}
          onApplyWorkspace={(next) => setMonitorWorkspace(next)}
          onToggleLiveUpdates={() => {
            setLiveUpdates((current) => !current);
            setToolbarNotice(liveUpdates ? "Monitor / 实时显示已暂停：采样与时间窗冻结" : "已恢复跟随实时尾部");
          }}
          onSetLayoutLocked={(locked) => setMonitorWorkspace((current) => setMonitorLayoutLocked(current, locked))}
          onSetCompactType={(compactType) => setMonitorWorkspace((current) => setMonitorCompactType(current, compactType))}
          onRefreshBagStatus={() => void refreshBagPlayStatus()}
          onStartBagPlay={(bagPath) => void startBagPlay(bagPath)}
          onStopBagPlay={() => void stopBagPlay()}
        />
      ) : appPage === "motor" ? (
        <MotorPage
          bridge={bridge}
          jointState={jointState}
          status={hardwareStatus}
          commandTopic={profile.commandTopic}
          onStreamingChange={setControlStreaming}
          controlLocked={gravitySessionActive}
          controlLockedReason={gravitySessionActive ? "重力辨识运行中：禁用 Motor 滑块下发（Abort 重力辨识后恢复）" : ""}
        />
      ) : null}
      {(appPage === "dashboard" || topicsVisited) && (
      <main hidden={appPage !== "dashboard"} className={`workspace ${sidebars.right ? "" : "right-sidebar-collapsed"}`} style={layoutStyle}>
      <header className="app-toolbar" role="toolbar" aria-label="应用工具栏">
        <div className="toolbar-actions" role="group" aria-label="全局操作">
        <button
          type="button"
          className="toolbar-action"
          aria-label="刷新全部状态"
          title="刷新 Topics 与 Controller 列表"
          disabled={topicRefreshing || rosControlRefreshing}
          onClick={() => {
            void refreshTopics();
            void refreshRosControllers();
          }}
        >
          <span className={topicRefreshing || rosControlRefreshing ? "spin" : ""}>↻</span>全部刷新
        </button>
          <button
            type="button"
            className={`toolbar-action ${liveUpdates ? "" : "active"}`}
            aria-pressed={!liveUpdates}
            onClick={() => {
              setLiveUpdates((current) => !current);
              setToolbarNotice(liveUpdates ? "实时数据显示已暂停；连接和 rosbag 录制不受影响" : "实时数据显示已恢复");
            }}
            title="暂停或恢复 Topic、JointState 与状态消息的界面更新"
          ><span>{liveUpdates ? "Ⅱ" : "▶"}</span>{liveUpdates ? "暂停显示" : "继续显示"}</button>
          <button
            type="button"
            className={`toolbar-action record ${rosbagStatus?.recording ? "active" : ""}`}
            aria-pressed={Boolean(rosbagStatus?.recording)}
            disabled={Boolean(toolbarBusy)}
            onClick={() => void toggleRosbagRecording()}
            title={rosbagStatus?.outputPath || "在 Jetson 上录制全部 ROS Topics"}
          ><span>{rosbagStatus?.recording ? "■" : "●"}</span>{toolbarBusy === "record" ? "处理中…" : rosbagStatus?.recording ? "停止录制" : "开始录制"}</button>
          <button type="button" className="toolbar-action" disabled={Boolean(toolbarBusy)} onClick={() => void saveDiagnostics()} title="导出连接、Topics、Controller、Fault 和消息统计"><span>⇩</span>{toolbarBusy === "diagnostics" ? "保存中…" : "诊断快照"}</button>
          <button type="button" className="toolbar-action" onClick={resetWorkspaceLayout} title="恢复面板尺寸并展开全部面板"><span>⊞</span>重置布局</button>
        </div>
      </header>
      <aside
        ref={topicSidebarRef}
        className={`topic-sidebar ${sidebars.left ? "" : "sidebar-collapsed"} ${panels.topics ? "" : "topics-pane-collapsed"} ${panels.rosControl ? "" : "control-pane-collapsed"}`}
      >
        {!sidebars.left && <button type="button" className="sidebar-rail-toggle" aria-label="展开左侧栏" title="展开左侧栏" onClick={() => setSidebars((current) => ({ ...current, left: true }))}>›</button>}
        <section className={`sidebar-section topics-section ${panels.topics ? "expanded" : "collapsed"}`}>
          <PanelTitle
            title="Topics"
            meta={topicFilter ? `${filteredTopics.length}/${topics.length}` : String(topics.length)}
            expanded={panels.topics}
            onRefresh={() => void refreshTopics()}
            refreshing={topicRefreshing}
            onCollapseSidebar={() => setSidebars((current) => ({ ...current, left: false }))}
            collapseSidebarLabel="收起左侧栏"
            onToggle={() => togglePanel("topics")}
          />
          <div className="section-content topic-filter">
            <input
              type="search"
              aria-label="过滤 Topics"
              placeholder="搜索 Topic 或消息类型"
              value={topicFilter}
              onChange={(event) => setTopicFilter(event.target.value)}
            />
            <span>{filteredTopics.length}/{topics.length}</span>
          </div>
          <div className="section-content topic-list">
            {topicRefreshError && <div className="topic-list-error">刷新失败：{topicRefreshError}</div>}
            {filteredTopics.map((topic) => <button key={topic.name} className={!selectedNode && selected === topic.name ? "active" : ""} title={`${topic.name}\n${topic.types.join(", ")}`} onClick={() => void selectTopic(topic)}><strong>{topic.name}</strong><small>{topic.types.join(", ")}</small></button>)}
            {topics.length > 0 && filteredTopics.length === 0 && <div className="topic-filter-empty">没有匹配的 Topic</div>}
          </div>
        </section>
        {panels.topics && panels.rosControl && (
          <ResizeHandle
            orientation="horizontal"
            label="调整 Topics 和 ROS Control 高度"
            value={layout.leftTopRatio * 100}
            className="row-resizer"
            onPointerDown={beginSplitResize}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                nudgeSplit(event.key === "ArrowUp" ? -0.03 : 0.03);
              }
            }}
          />
        )}
        <section className={`sidebar-section ros-control-panel ${panels.rosControl ? "expanded" : "collapsed"}`} aria-label="ROS Control Controllers">
          <PanelTitle
            title="ROS Control"
            meta={rosControl ? (rosControl.available ? String(rosControl.controllers.length) : "离线") : "检查中"}
            expanded={panels.rosControl}
            onRefresh={() => void refreshRosControllers()}
            refreshing={rosControlRefreshing}
            onToggle={() => togglePanel("rosControl")}
          />
          <div className="section-content ros-control-content">
            <div className="controller-manager-name">{rosControl?.manager ?? "/controller_manager"}</div>
            <div className="controller-list">
            {controllerActionError && <div className="controller-action-feedback error">{controllerActionError}</div>}
            {controllerActionMessage && <div className="controller-action-feedback success">{controllerActionMessage}</div>}
            {rosControl?.controllers.map((controller) => (
              <div className="controller-item" key={controller.name}>
                <button type="button" className="controller-focus-button" aria-label={`在 Topic Graph 聚焦 Controller ${controller.name}`} title={`在 Topic Graph 聚焦 ${controller.name}`} onClick={() => { setFocusController(controller.name); setSelectedNode(`/${controller.name.replace(/^\/+/, "")}`); setCenterTab("graph"); }} />
                <div>
                  <span className={`controller-state ${controller.state}`} /> <strong>{controller.name}</strong>
                  {isTrajectoryController(controller) && <span className="controller-tag" title="激活后可在 Robot View 拖拽 TCP 并下发轨迹">轨迹</span>}
                </div>
                <small title={controller.typeName}>{controller.typeName}</small>
                <span className={`controller-state-label ${controller.state}`}>{controller.state}</span>
                <button
                  className={`controller-action-button ${controller.state === "active" ? "deactivate" : "activate"}`}
                  type="button"
                  disabled={Boolean(controllerAction) || rosControlRefreshing}
                  aria-label={`${controller.state === "active" ? "停用" : "激活"} Controller ${controller.name}`}
                  onClick={() => void switchController(controller, controller.state === "active" ? "deactivate" : "activate")}
                >
                  {controllerAction?.name === controller.name
                    ? "Working…"
                    : controller.state === "active" ? "Deactivate" : "Activate"}
                </button>
              </div>
            ))}
            {(!rosControl || rosControl.controllers.length === 0) && (
              <div className={`controller-empty ${rosControl && !rosControl.available ? "error" : ""}`}>
                {rosControl?.message || "正在读取 Controller…"}
              </div>
            )}
            </div>
          </div>
        </section>
      </aside>
      <section className="urdf-panel">
        <div className="panel-title center-tabs">
          <div className="center-tab-list" role="tablist" aria-label="中心视图">
            <button type="button" role="tab" aria-selected={centerTab === "robot"} className={centerTab === "robot" ? "active" : ""} onClick={() => setCenterTab("robot")}>Robot View</button>
            <button type="button" role="tab" aria-selected={centerTab === "graph"} className={centerTab === "graph" ? "active" : ""} onClick={() => setCenterTab("graph")}>Topic Graph</button>
            <button type="button" role="tab" aria-selected={centerTab === "positions"} className={centerTab === "positions" ? "active" : ""} onClick={() => setCenterTab("positions")}>位置</button>
          </div>
          <span>{centerTab === "robot" ? profile.urdfTopic : centerTab === "graph" ? "ROS Node / Topic topology" : "保存的关节位置"}</span>
        </div>
        <div className="robot-view-pane" hidden={centerTab !== "robot"}>
          {(robotVisited || (appPage === "dashboard" && centerTab === "robot")) && (
            <UrdfViewer
              active={appPage === "dashboard" && centerTab === "robot" && windowVisible}
              xml={urdf}
              jointState={jointState}
              bridge={bridge}
              tcpLink={profile.tcpLink}
              trajectoryController={positionMotion.busy && trajectoryController ? { ...trajectoryController, readinessError: "点位运动尚未结束，请先取消或等待完成" } : trajectoryController}
              motionInfo={positionMotion.state.phase !== "idle" ? {
                state: "position", label: positionMotion.state.label, phase: positionMotion.state.phase, message: positionMotion.state.message,
              } : positionMotion.busy ? { state: "position", label: "点位运动", phase: "validating", message: "已有会话的点位任务尚未结束" } : { state: "idle" }}
              onSendTrajectory={sendTrajectory}
              jointMotion={positionMotion}
              plannerLog={<ControlLogViewer profile={profile} active={appPage === "dashboard" && centerTab === "robot" && windowVisible} connected={stage === "connected"} preferredSource="moveit" />}
              rgbdCloud={rgbdSession.cloud}
              rgbdVisible={rgbdSession.visible}
              rgbdPointSize={rgbdSession.pointSize}
              rgbdColorMode={rgbdColorMode}
              rgbdNearM={rgbdSession.nearM}
              rgbdFarM={rgbdSession.farM}
              rgbdStatus={{
                enabled: profile.rgbdEnabled,
                stale: rgbdSession.stale,
                tfOk: rgbdSession.tfOk,
                tfError: rgbdSession.tfError,
                fps: rgbdSession.fps,
                stampDiffNs: rgbdSession.cloud?.stampDiffNs,
                pointCount: rgbdSession.cloud?.count ?? 0,
              }}
              onRgbdVisibleChange={(visible) => setRgbdSession((c) => ({ ...c, visible }))}
              onRgbdPointSizeChange={(pointSize) => setRgbdSession((c) => ({ ...c, pointSize }))}
              onRgbdColorModeChange={setRgbdColorMode}
              onRgbdNearFarChange={(nearM, farM) => setRgbdSession((c) => ({ ...c, nearM, farM }))}
            />
          )}
        </div>
        {centerTab === "graph" && appPage === "dashboard" && <Suspense fallback={<div className="graph-loading">正在加载 Topic Graph…</div>}><TopicGraph bridge={bridge} onSelectTopic={selectTopic} onSelectNode={setSelectedNode} selectedTopic={selected} selectedNode={selectedNode} focusController={focusController} onClearControllerFocus={() => setFocusController("")} /></Suspense>}
        {centerTab === "positions" && (
          <PositionPage
            profileKey={positionProfileKey}
            store={positionStore}
            captureError={captureError}
          urdfXml={urdf || previewUrdf}
            onCreate={createPosition}
            onUpdate={editPosition}
            onDelete={removePosition}
            onCapture={capturePose}
            motion={positionMotion}
            planner={positionPlanner}
          />
        )}
      </section>
      <section className={`data-panel ${sidebars.right ? "" : "sidebar-collapsed"}`}>
        {!sidebars.right && <button type="button" className="sidebar-rail-toggle" aria-label="展开右侧栏" title="展开右侧栏" onClick={() => setSidebars((current) => ({ ...current, right: true }))}>‹</button>}
        <section className={`data-section inspector-section ${panels.inspector ? "expanded" : "collapsed"}`}>
          <PanelTitle
            title="Inspector"
            meta={selectedNode ? "已选择 Node" : selected ? (messages[selected] ? `${messages[selected].hz.toFixed(1)} Hz · ${messages[selected].count} 条` : "已选择 Topic") : "请选择 Topic / Node"}
            expanded={panels.inspector}
            onCollapseSidebar={() => setSidebars((current) => ({ ...current, right: false }))}
            collapseSidebarLabel="收起右侧栏"
            onToggle={() => togglePanel("inspector")}
          />
          {appPage === "dashboard" && panels.inspector && sidebars.right && <TopicInspector onDataVisibilityChange={setInspectorDataVisible} bridge={bridge} selected={selected} selectedNode={selectedNode} topicType={selectedTopicType} sample={messages[selected]} subscribeError={topicSubscribeError} monitorPanels={monitorWorkspace.dashboards} selectedMonitorPanelId={monitorWorkspace.selectedDashboardId} onAddToDataGraph={addToMonitor} />}
        </section>
      </section>
      {sidebars.left && <ResizeHandle
        orientation="vertical"
        label="调整 Topics 侧栏宽度"
        value={layout.leftWidth}
        minimum={180}
        maximum={480}
        className="column-resizer left-column-resizer"
        onPointerDown={(event) => beginColumnResize("left", event)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            nudgeColumn("left", event.key === "ArrowLeft" ? -12 : 12);
          }
        }}
      />}
      {sidebars.right && <ResizeHandle
        orientation="vertical"
        label="调整数据侧栏宽度"
        value={layout.rightWidth}
        minimum={260}
        maximum={560}
        className="column-resizer right-column-resizer"
        onPointerDown={(event) => beginColumnResize("right", event)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            nudgeColumn("right", event.key === "ArrowLeft" ? 12 : -12);
          }
        }}
      />}
      </main>
      )}
      </div>
      </div>
      {versionDialogOpen && bridgeVersionCheck?.status === "mismatch" && (
        <ModalShell
          title="Bridge 版本不匹配"
          onClose={skipBridgeUpgrade}
          actions={(
            <>
              <button type="button" onClick={skipBridgeUpgrade}>跳过</button>
              <button type="button" className="primary" onClick={() => void upgradeBridge()}>升级</button>
            </>
          )}
        >
          <p className="modal-hint">远端 Bridge 与本机期望版本不一致。升级将执行 deploy:bridge（rsync + colcon + 重启），不会烧录 STM32，也不会同步 ros2-stack。</p>
          <div className="version-compare">
            <p><strong>本地期望：</strong>{formatBridgeVersionLabel(bridgeVersionCheck.local)}</p>
            <p><strong>远端当前：</strong>{formatBridgeVersionLabel(bridgeVersionCheck.remote)}</p>
          </div>
        </ModalShell>
      )}
      {connectionDialogOpen && (
        <ModalShell
          title="连接配置"
          onClose={() => setConnectionDialogOpen(false)}
          actions={<><button type="button" className="ghost" onClick={() => setConnectionDialogOpen(false)}>取消</button><button type="button" className="primary" onClick={saveConnectionSettings}>保存配置</button></>}
        >
          <p className="modal-hint">当前连接不会被中断；保存的配置将在下次重连时生效。</p>
          <ProfileForm profile={profileDraft} onChange={setProfileDraft} />
        </ModalShell>
      )}
      {settingsDialogOpen && (
        <ModalShell
          title="应用设置"
          onClose={() => setSettingsDialogOpen(false)}
          actions={<><button type="button" className="ghost" onClick={() => setSettingsDialogOpen(false)}>取消</button><button type="button" className="primary" onClick={saveToolbarSettings}>保存设置</button></>}
        >
          <div className="settings-form">
            <label>Topics / Controller 自动刷新间隔（秒）<input type="number" min="5" max="300" value={settingsDraft.refreshIntervalSeconds} onChange={(event) => setSettingsDraft((current) => ({ ...current, refreshIntervalSeconds: Number(event.target.value) }))} /></label>
            <label className="settings-check"><input type="checkbox" checked={settingsDraft.includeMessagePreviews} onChange={(event) => setSettingsDraft((current) => ({ ...current, includeMessagePreviews: event.target.checked }))} />诊断快照包含最新消息摘要（单条最多 4 KiB）</label>
            <label className="settings-check"><input type="checkbox" checked={navigateStatusOnConnect} onChange={(event) => setNavigateStatusOnConnect(event.target.checked)} />连接成功后打开 Status（默认开启）</label>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
