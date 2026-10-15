import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { BridgeClient } from "./bridge";
import robotConsoleIcon from "./assets/robot-console-icon.png";
import { AppNav } from "./AppNav";
import type { AppPage } from "./AppNav";
import { Joint4CalibrationPage } from "./Joint4CalibrationPage";
import { MotorPage } from "./MotorPage";
import { MonitorPage } from "./MonitorPage";
import { TopicInspector } from "./TopicInspector";
import { addFieldsToSeries } from "./dataGraphLogic";
import type { AgentServiceStatus, BridgeEnvelope, ConnectionProfile, ControllerInfo, HardwareStatus, RosbagPlayStatus, RosbagStatus, RosControlStatus, TopicInfo } from "./types";
import {
  addMonitorDashboard,
  addPanelsToDashboard,
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
  updateMonitorFromMessage,
} from "./monitorLogic";
import type { MonitorWorkspace } from "./monitorLogic";
import { createTrajectoryPayload, findActiveTrajectoryController, isTrajectoryController } from "./trajectoryLogic";
import { UrdfViewer } from "./UrdfViewer";
import type { TrajectorySendRequest } from "./UrdfViewer";
import {
  applyRecentHostToProfile,
  CONNECT_STEPS,
  connectStepStatus,
  defaultPanelState,
  defaultSidebarState,
  deriveConnectStatusLights,
  domainMismatchHint,
  formatConnectError,
  isAgentOnline,
  isRosReady,
  loadLastKnownDomainId,
  loadPanelState,
  loadProfile,
  loadRecentHosts,
  loadSidebarState,
  nextTopicSample,
  rememberLastKnownDomainId,
  rememberSuccessfulHost,
} from "./appLogic";
import type { CollapsiblePanel, ConnectStepId, PanelState, RecentHost, TopicSample } from "./appLogic";
import { clamp, defaultLayoutSizes, loadLayoutSizes, resizeColumn, resizeSplit } from "./layoutLogic";
import type { LayoutSizes } from "./layoutLogic";
import { buildDiagnosticsSnapshot, loadToolbarSettings } from "./toolbarLogic";
import type { ToolbarSettings } from "./toolbarLogic";

type Stage = "idle" | "ssh" | "tunnel" | "bridge" | "connected" | "failed";
const TopicGraph = lazy(() => import("./TopicGraph").then((module) => ({ default: module.TopicGraph })));
type CenterTab = "robot" | "graph";

const stageNames: Record<Stage, string> = {
  idle: "未连接",
  ssh: "检查 SSH",
  tunnel: "建立会话",
  bridge: "连接 Bridge",
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
}: {
  lights: ReturnType<typeof deriveConnectStatusLights>;
  domainHint: string;
  rosReady?: boolean;
  compact?: boolean;
}) {
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
        </div>
      </details>
    </div>
  );
}

export default function App() {
  const [appPage, setAppPage] = useState<AppPage>(() => {
    const saved = localStorage.getItem("robot-console-page");
    return saved === "motor" || saved === "calibration" || saved === "monitor" ? saved : "dashboard";
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
  const [lastKnownDomainId, setLastKnownDomainId] = useState<number | null>(() => loadLastKnownDomainId());
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [topicFilter, setTopicFilter] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [selectedNode, setSelectedNode] = useState("");
  const [topicSubscribeError, setTopicSubscribeError] = useState("");
  const [messages, setMessages] = useState<Record<string, TopicSample>>({});
  const [urdf, setUrdf] = useState("");
  const [jointState, setJointState] = useState<{ name?: string[]; position?: number[] } | null>(null);
  const [hardwareStatus, setHardwareStatus] = useState<HardwareStatus | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentServiceStatus | null>(null);
  const [agentError, setAgentError] = useState("");
  const [rosControl, setRosControl] = useState<RosControlStatus | null>(null);
  const [topicRefreshing, setTopicRefreshing] = useState(false);
  const [topicRefreshError, setTopicRefreshError] = useState("");
  const [rosControlRefreshing, setRosControlRefreshing] = useState(false);
  const [controllerAction, setControllerAction] = useState<{ name: string; action: "activate" | "deactivate" } | null>(null);
  const [controllerActionMessage, setControllerActionMessage] = useState("");
  const [controllerActionError, setControllerActionError] = useState("");
  const [controlStreaming, setControlStreaming] = useState(false);
  const [effectiveLocalPort, setEffectiveLocalPort] = useState<number | null>(null);
  const [centerTab, setCenterTab] = useState<CenterTab>("robot");
  const [monitorWorkspace, setMonitorWorkspace] = useState<MonitorWorkspace>(() =>
    loadMonitorWorkspace(loadProfile().jointStateTopic),
  );
  const [rosbagPlayStatus, setRosbagPlayStatus] = useState<RosbagPlayStatus | null>(null);
  const [bagBusy, setBagBusy] = useState(false);
  const [bagNotice, setBagNotice] = useState("");
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
  // 只有 active 的轨迹控制器才允许在 Robot View 拖拽 TCP 并下发轨迹。
  const trajectoryController = useMemo(
    () => findActiveTrajectoryController(rosControl?.controllers ?? []),
    [rosControl],
  );

  const sendTrajectory = useCallback(async (request: TrajectorySendRequest) => {
    const controller = trajectoryController;
    if (!controller) throw new Error("没有激活的轨迹控制器");
    await bridge.request({
      ...createTrajectoryPayload(request.jointNames, request.points),
      topic: controller.topic,
    }, 30_000);
  }, [bridge, trajectoryController]);

  const addToMonitor = useCallback((fieldPath: string, dashboardId: string) => {
    if (!selected) return;
    const sample = messages[selected];
    if (!sample) return;
    setMonitorWorkspace((current) => {
      const dashboard = current.dashboards.find((entry) => entry.id === dashboardId);
      if (!dashboard) return current;
      const series = addFieldsToSeries([], selected, fieldPath, sample.data);
      return addPanelsToDashboard(current, dashboard.id, series);
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
        const now = performance.now();
        setMessages((current) => {
          const previous = current[message.topic!];
          return {
            ...current,
            [message.topic!]: nextTopicSample(previous, message.data, now),
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
      if (message.op === "disconnected") {
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
    setAgentStatus(null);
    setAgentError("");
    setRosControl(null);
    setFocusController("");
    setTopicRefreshing(false);
    setTopicRefreshError("");
    setRosControlRefreshing(false);
    setControllerAction(null);
    setControllerActionMessage("");
    setControllerActionError("");
    setControlStreaming(false);
    setEffectiveLocalPort(null);
    setLiveUpdates(true);
    setRosbagStatus(null);
    setRosbagPlayStatus(null);
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
    localStorage.setItem("easy-debug-profile", JSON.stringify(profile));
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
      await bridge.connect({ ...profile, localPort });
      setBridgeUp(true);
      const discovered = await bridge.listTopics();
      setTopics(discovered);
      setTopicRefreshError("");
      bridge.send({ op: "subscribe", topic: profile.urdfTopic, type: "std_msgs/msg/String" });
      bridge.send({ op: "subscribe", topic: profile.jointStateTopic, type: "sensor_msgs/msg/JointState" });
      bridge.send({ op: "subscribe", topic: profile.statusTopic, type: "microros_stm32h723_bridge/msg/HardwareStatus" });

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
      rememberLastKnownDomainId(profile.rosDomainId);
      setLastKnownDomainId(profile.rosDomainId);

      void invoke<RosbagStatus>("get_rosbag_status", { profile })
        .then(setRosbagStatus)
        .catch((reason) => setToolbarNotice(`无法读取 rosbag 状态：${reason instanceof Error ? reason.message : String(reason)}`));
      void invoke<RosbagPlayStatus>("get_rosbag_play_status", { profile })
        .then(setRosbagPlayStatus)
        .catch(() => undefined);
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : String(reason);
      setFailedStep(activeStep);
      setError(formatConnectError(raw, activeStep));
      setStage("failed");
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
    } catch (reason) {
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

  if (stage !== "connected") {
    return (
      <main className="connect-shell">
        <section className="connect-card">
          <div className="brand"><img className="brand-mark" src={robotConsoleIcon} alt="" /><div><h1>Robot Console</h1><p>ROS 2 机器人调试工作台</p></div></div>
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
          <ConnectStatusStrip lights={statusLights} domainHint={domainHint} />
          <div className="connect-actions">
            <span className={`status ${stage}`}>{stageNames[stage]}</span>
            <button onClick={connect} disabled={["ssh", "tunnel", "bridge"].includes(stage)}>连接 Jetson</button>
          </div>
          {error && (
            <div className="error-panel">
              <pre className="error-box">{error}</pre>
              <button type="button" className="copy-error" onClick={() => void copyConnectError()}>
                {errorCopied ? "已复制" : "复制错误"}
              </button>
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
      <AppNav page={appPage} expanded={navExpanded} onSelect={setAppPage} onToggle={() => setNavExpanded((current) => !current)} />
      {!navExpanded && <button className="nav-reopen" aria-label="展开主工具栏" onClick={() => setNavExpanded(true)}>›</button>}
      <div className="app-page-content">
      {appPage === "calibration" ? (
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
          onSelectDashboard={(dashboardId) => setMonitorWorkspace((current) => selectMonitorDashboard(current, dashboardId))}
          onAddDashboard={(dashboard) => setMonitorWorkspace((current) => addMonitorDashboard(current, dashboard))}
          onRenameDashboard={(dashboardId, name) => setMonitorWorkspace((current) => renameMonitorDashboard(current, dashboardId, name))}
          onDeleteDashboard={(dashboardId) => setMonitorWorkspace((current) => deleteMonitorDashboard(current, dashboardId, profile.jointStateTopic))}
          onLayoutChange={(dashboardId, layout) => setMonitorWorkspace((current) => updateDashboardLayout(current, dashboardId, layout))}
          onRemovePanel={(dashboardId, panelId) => setMonitorWorkspace((current) => removePanelFromDashboard(current, dashboardId, panelId))}
          onClearPanels={(dashboardId) => setMonitorWorkspace((current) => clearDashboardPanels(current, dashboardId))}
          onResetLayout={(dashboardId) => setMonitorWorkspace((current) => resetDashboardPanelLayouts(current, dashboardId))}
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
        />
      ) : (
      <main className={`workspace ${sidebars.right ? "" : "right-sidebar-collapsed"}`} style={layoutStyle}>
      <header className="app-toolbar" role="toolbar" aria-label="应用工具栏">
        <div className="toolbar-actions" role="group" aria-label="全局操作">
          <button type="button" className="toolbar-action" onClick={openConnectionSettings} title="编辑 SSH 与 ROS 连接配置；重连后生效"><span>⌁</span>连接配置</button>
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
          <button type="button" className="toolbar-action" onClick={openToolbarSettings} title="配置自动刷新与诊断快照"><span>⚙</span>设置</button>
        </div>
        {toolbarNotice && <output className="toolbar-notice" title={toolbarNotice}>{toolbarNotice}</output>}
        <span className="toolbar-spacer" />
        <ConnectStatusStrip
          lights={statusLights}
          domainHint={domainHint}
          rosReady={rosReady}
          compact
        />
        <span className="connected-dot" />{profile.name}
        <span className="tunnel-port" title="SSH 本地转发端口">localhost:{effectiveLocalPort ?? profile.localPort}</span>
        <span
          className={`agent-badge ${isAgentOnline(agentStatus) ? "running" : agentError ? "unknown" : "stopped"}`}
          title={agentError || (agentStatus ? `${agentStatus.description}\n${agentStatus.activeState}/${agentStatus.subState}\nPID ${agentStatus.mainPid}\n开机状态：${agentStatus.unitFileState}` : "正在检查 systemd 状态")}
        >
          <span /> micro-ROS Agent：{isAgentOnline(agentStatus) ? "运行中" : agentError ? "检查失败" : agentStatus ? "未运行" : "检查中"}
        </span>
        <button className="ghost disconnect-btn" onClick={disconnect} title="断开 SSH 隧道与 Bridge">断开</button>
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
          </div>
          <span>{centerTab === "robot" ? profile.urdfTopic : "ROS Node / Topic topology"}</span>
        </div>
        {centerTab === "robot"
          ? (
            <UrdfViewer
              xml={urdf}
              jointState={jointState}
              bridge={bridge}
              tcpLink={profile.tcpLink}
              trajectoryController={trajectoryController}
              onSendTrajectory={sendTrajectory}
            />
          )
          : <Suspense fallback={<div className="graph-loading">正在加载 Topic Graph…</div>}><TopicGraph bridge={bridge} onSelectTopic={selectTopic} onSelectNode={setSelectedNode} selectedTopic={selected} selectedNode={selectedNode} focusController={focusController} onClearControllerFocus={() => setFocusController("")} /></Suspense>}
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
          <TopicInspector bridge={bridge} selected={selected} selectedNode={selectedNode} topicType={selectedTopicType} sample={messages[selected]} subscribeError={topicSubscribeError} monitorPanels={monitorWorkspace.dashboards} selectedMonitorPanelId={monitorWorkspace.selectedDashboardId} onAddToDataGraph={addToMonitor} />
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
          </div>
        </ModalShell>
      )}
    </div>
  );
}
