import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { BridgeClient } from "./bridge";
import robotConsoleIcon from "./assets/robot-console-icon.png";
import { MotorControl } from "./MotorControl";
import type { AgentServiceStatus, BridgeEnvelope, ConnectionProfile, HardwareStatus, RosControlStatus, TopicInfo } from "./types";
import { UrdfViewer } from "./UrdfViewer";
import { loadPanelState, loadProfile, nextTopicSample } from "./appLogic";
import type { CollapsiblePanel, PanelState, TopicSample } from "./appLogic";
import { clamp, loadLayoutSizes, resizeColumn, resizeSplit } from "./layoutLogic";
import type { LayoutSizes } from "./layoutLogic";

type Stage = "idle" | "ssh" | "tunnel" | "bridge" | "connected" | "failed";
const LIST_REFRESH_INTERVAL_MS = 30_000;

const stageNames: Record<Stage, string> = {
  idle: "未连接",
  ssh: "检查 SSH",
  tunnel: "建立隧道",
  bridge: "连接 Bridge",
  connected: "已连接",
  failed: "连接失败",
};

function PanelTitle({
  title,
  meta,
  expanded,
  onToggle,
  onRefresh,
  refreshing = false,
  className = "",
}: {
  title: string;
  meta: string;
  expanded: boolean;
  onToggle(): void;
  onRefresh?(): void;
  refreshing?: boolean;
  className?: string;
}) {
  return (
    <div className={`panel-title ${className}`}>
      <strong>{title}</strong>
      <div className="panel-title-actions">
        <span className="panel-meta">{meta}</span>
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

function ProfileForm({ profile, onChange }: { profile: ConnectionProfile; onChange(profile: ConnectionProfile): void }) {
  const field = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) =>
    onChange({ ...profile, [key]: value });
  return (
    <div className="profile-grid">
      <label>配置名称<input value={profile.name} onChange={(e) => field("name", e.target.value)} /></label>
      <label>SSH 主机<input value={profile.host} onChange={(e) => field("host", e.target.value)} placeholder="damiao" /></label>
      <label>SSH 用户名<input value={profile.username} onChange={(e) => field("username", e.target.value)} placeholder="使用 ~/.ssh/config" /></label>
      <label>SSH 端口<input type="number" value={profile.sshPort} onChange={(e) => field("sshPort", Number(e.target.value))} /></label>
      <label>私钥路径<input value={profile.identityFile} onChange={(e) => field("identityFile", e.target.value)} placeholder="使用 SSH Agent / config" /></label>
      <label>ROS_DOMAIN_ID<input type="number" value={profile.rosDomainId} onChange={(e) => field("rosDomainId", Number(e.target.value))} /></label>
      <label>ROS 环境脚本<input value={profile.rosSetupScript} onChange={(e) => field("rosSetupScript", e.target.value)} placeholder="/path/to/install/setup.bash" /></label>
      <label>URDF Topic<input value={profile.urdfTopic} onChange={(e) => field("urdfTopic", e.target.value)} /></label>
      <label>JointState Topic<input value={profile.jointStateTopic} onChange={(e) => field("jointStateTopic", e.target.value)} /></label>
      <label>Command Topic<input value={profile.commandTopic} onChange={(e) => field("commandTopic", e.target.value)} /></label>
      <label>Status Topic<input value={profile.statusTopic} onChange={(e) => field("statusTopic", e.target.value)} /></label>
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState(loadProfile);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState("");
  const [topics, setTopics] = useState<TopicInfo[]>([]);
  const [selected, setSelected] = useState<string>("");
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
  const [controlStreaming, setControlStreaming] = useState(false);
  const [effectiveLocalPort, setEffectiveLocalPort] = useState<number | null>(null);
  const [panels, setPanels] = useState<PanelState>(loadPanelState);
  const [layout, setLayout] = useState<LayoutSizes>(loadLayoutSizes);
  const topicSidebarRef = useRef<HTMLElement>(null);
  const dataPanelRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const topicRefreshInFlightRef = useRef(false);
  const rosControlRefreshInFlightRef = useRef(false);
  const bridge = useMemo(() => new BridgeClient(), []);

  useEffect(() => {
    localStorage.setItem("easy-debug-panels", JSON.stringify(panels));
  }, [panels]);

  useEffect(() => {
    localStorage.setItem("easy-debug-layout", JSON.stringify(layout));
  }, [layout]);

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

  const beginSplitResize = (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => {
    const container = side === "left" ? topicSidebarRef.current : dataPanelRef.current;
    if (!container) return;
    beginResize("row-resize", (pointer) => {
      const bounds = container.getBoundingClientRect();
      const ratio = resizeSplit(pointer.clientY, bounds.top, bounds.height);
      setLayout((current) => ({ ...current, [side === "left" ? "leftTopRatio" : "rightTopRatio"]: ratio }));
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

  const nudgeSplit = (side: "left" | "right", delta: number) => {
    setLayout((current) => {
      const key = side === "left" ? "leftTopRatio" : "rightTopRatio";
      return { ...current, [key]: clamp(current[key] + delta, 0.18, 0.82) };
    });
  };

  const layoutStyle = {
    "--left-width": `${layout.leftWidth}px`,
    "--right-width": `${layout.rightWidth}px`,
    "--left-top-size": `${Math.round(layout.leftTopRatio * 10_000) / 100}%`,
    "--right-top-size": `${Math.round(layout.rightTopRatio * 10_000) / 100}%`,
  } as CSSProperties;

  const refreshTopics = useCallback(async () => {
    if (topicRefreshInFlightRef.current) return;
    topicRefreshInFlightRef.current = true;
    setTopicRefreshing(true);
    try {
      setTopics(await bridge.listTopics());
      setTopicRefreshError("");
    } catch (reason) {
      setTopicRefreshError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      topicRefreshInFlightRef.current = false;
      setTopicRefreshing(false);
    }
  }, [bridge]);

  const refreshRosControllers = useCallback(async () => {
    if (rosControlRefreshInFlightRef.current) return;
    rosControlRefreshInFlightRef.current = true;
    setRosControlRefreshing(true);
    try {
      setRosControl(await invoke<RosControlStatus>("check_ros_controllers", { profile }));
    } catch (reason) {
      setRosControl({
        manager: "/controller_manager",
        available: false,
        controllers: [],
        message: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      rosControlRefreshInFlightRef.current = false;
      setRosControlRefreshing(false);
    }
  }, [profile]);

  useEffect(() => {
    return bridge.onMessage((message: BridgeEnvelope) => {
      if (message.op === "topic_message" && message.topic) {
        setMessages((current) => {
          const now = performance.now();
          const previous = current[message.topic!];
          return {
            ...current,
            [message.topic!]: nextTopicSample(previous, message.data, now),
          };
        });
        if (message.topic === profile.urdfTopic && typeof message.data === "string") setUrdf(message.data);
        if (message.topic === profile.jointStateTopic && message.data && typeof message.data === "object") {
          setJointState(message.data as { name?: string[]; position?: number[] });
        }
        if (message.topic === profile.statusTopic && message.data && typeof message.data === "object") {
          setHardwareStatus(message.data as HardwareStatus);
        }
      }
      if (message.op === "disconnected") setStage("failed");
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
        }
      } catch (reason) {
        if (!disposed) {
          setAgentStatus(null);
          setAgentError(reason instanceof Error ? reason.message : String(reason));
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
    const timer = window.setInterval(() => void refreshTopics(), LIST_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshTopics, stage]);

  useEffect(() => {
    if (stage !== "connected") return;
    void refreshRosControllers();
    const timer = window.setInterval(() => void refreshRosControllers(), LIST_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshRosControllers, stage]);

  async function connect() {
    setError("");
    localStorage.setItem("easy-debug-profile", JSON.stringify(profile));
    try {
      setStage("ssh");
      await invoke("check_ssh", { profile });
      try {
        setAgentStatus(await invoke<AgentServiceStatus>("check_micro_ros_agent", { profile }));
        setAgentError("");
      } catch (reason) {
        setAgentStatus(null);
        setAgentError(reason instanceof Error ? reason.message : String(reason));
      }
      setStage("tunnel");
      const localPort = await invoke<number>("start_session", { profile });
      setEffectiveLocalPort(localPort);
      setStage("bridge");
      await bridge.connect({ ...profile, localPort });
      const discovered = await bridge.listTopics();
      setTopics(discovered);
      setTopicRefreshError("");
      bridge.send({ op: "subscribe", topic: profile.urdfTopic, type: "std_msgs/msg/String" });
      bridge.send({ op: "subscribe", topic: profile.jointStateTopic, type: "sensor_msgs/msg/JointState" });
      bridge.send({ op: "subscribe", topic: profile.statusTopic, type: "microros_stm32h723_bridge/msg/HardwareStatus" });
      setStage("connected");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStage("failed");
      await invoke("stop_session").catch(() => undefined);
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
    setEffectiveLocalPort(null);
    setRosControl(null);
    setTopicRefreshError("");
    setStage("idle");
  }

  function selectTopic(topic: TopicInfo) {
    setSelected(topic.name);
    bridge.send({ op: "subscribe", topic: topic.name, type: topic.types[0] });
  }

  if (stage !== "connected") {
    return (
      <main className="connect-shell">
        <section className="connect-card">
          <div className="brand"><img className="brand-mark" src={robotConsoleIcon} alt="" /><div><h1>Robot Console</h1><p>ROS 2 机器人调试工作台</p></div></div>
          <ProfileForm profile={profile} onChange={setProfile} />
          <div className="connect-actions">
            <span className={`status ${stage}`}>{stageNames[stage]}</span>
            <button onClick={connect} disabled={["ssh", "tunnel", "bridge"].includes(stage)}>连接 Jetson</button>
          </div>
          {error && <pre className="error-box">{error}</pre>}
        </section>
      </main>
    );
  }

  return (
    <main className="workspace" style={layoutStyle}>
      <header>
        <div className="brand compact"><img className="brand-mark" src={robotConsoleIcon} alt="" /><strong>Robot Console</strong></div>
        <span className="connected-dot" />{profile.name}
        <span className="tunnel-port" title="SSH 本地转发端口">localhost:{effectiveLocalPort ?? profile.localPort}</span>
        <span
          className={`agent-badge ${agentStatus?.activeState === "active" && agentStatus?.subState === "running" ? "running" : agentError ? "unknown" : "stopped"}`}
          title={agentError || (agentStatus ? `${agentStatus.description}\n${agentStatus.activeState}/${agentStatus.subState}\nPID ${agentStatus.mainPid}\n开机状态：${agentStatus.unitFileState}` : "正在检查 systemd 状态")}
        >
          <span /> micro-ROS Agent：{agentStatus?.activeState === "active" && agentStatus?.subState === "running" ? "运行中" : agentError ? "检查失败" : agentStatus ? "未运行" : "检查中"}
        </span>
        <button className="ghost" onClick={disconnect}>断开</button>
      </header>
      <aside
        ref={topicSidebarRef}
        className={`topic-sidebar ${panels.topics ? "" : "topics-pane-collapsed"} ${panels.rosControl ? "" : "control-pane-collapsed"}`}
      >
        <section className={`sidebar-section topics-section ${panels.topics ? "expanded" : "collapsed"}`}>
          <PanelTitle
            title="Topics"
            meta={String(topics.length)}
            expanded={panels.topics}
            onRefresh={() => void refreshTopics()}
            refreshing={topicRefreshing}
            onToggle={() => togglePanel("topics")}
          />
          <div className="section-content topic-list">
            {topicRefreshError && <div className="topic-list-error">刷新失败：{topicRefreshError}</div>}
            {topics.map((topic) => <button key={topic.name} className={selected === topic.name ? "active" : ""} onClick={() => selectTopic(topic)}><strong>{topic.name}</strong><small>{topic.types.join(", ")}</small></button>)}
          </div>
        </section>
        {panels.topics && panels.rosControl && (
          <ResizeHandle
            orientation="horizontal"
            label="调整 Topics 和 ROS Control 高度"
            value={layout.leftTopRatio * 100}
            className="row-resizer"
            onPointerDown={(event) => beginSplitResize("left", event)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                nudgeSplit("left", event.key === "ArrowUp" ? -0.03 : 0.03);
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
            {rosControl?.controllers.map((controller) => (
              <div className="controller-item" key={controller.name}>
                <div><span className={`controller-state ${controller.state}`} /> <strong>{controller.name}</strong></div>
                <small title={controller.typeName}>{controller.typeName}</small>
                <span className={`controller-state-label ${controller.state}`}>{controller.state}</span>
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
      <section className="urdf-panel"><div className="panel-title">Robot View <span>{profile.urdfTopic}</span></div><UrdfViewer xml={urdf} jointState={jointState} bridge={bridge} /></section>
      <section
        ref={dataPanelRef}
        className={`data-panel ${panels.inspector ? "" : "inspector-collapsed"} ${panels.motor ? "" : "motor-collapsed"}`}
      >
        <section className={`data-section motor-section ${panels.motor ? "expanded" : "collapsed"}`}>
          <PanelTitle
            title="Motor Control"
            meta={`${controlStreaming ? "● 20 Hz · " : ""}${profile.commandTopic} · MIT`}
            expanded={panels.motor}
            onToggle={() => togglePanel("motor")}
          />
          <div className="section-content motor-panel-content">
            <MotorControl bridge={bridge} jointState={jointState} status={hardwareStatus} onStreamingChange={setControlStreaming} />
          </div>
        </section>
        {panels.motor && panels.inspector && (
          <ResizeHandle
            orientation="horizontal"
            label="调整 Motor Control 和 Topic Inspector 高度"
            value={layout.rightTopRatio * 100}
            className="row-resizer"
            onPointerDown={(event) => beginSplitResize("right", event)}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault();
                nudgeSplit("right", event.key === "ArrowUp" ? -0.03 : 0.03);
              }
            }}
          />
        )}
        <section className={`data-section inspector-section ${panels.inspector ? "expanded" : "collapsed"}`}>
          <PanelTitle
            title="Topic Inspector"
            meta={selected ? `${selected}${messages[selected] ? ` · ${messages[selected].hz.toFixed(1)} Hz · ${messages[selected].count} 条` : ""}` : "请选择 Topic"}
            expanded={panels.inspector}
            onToggle={() => togglePanel("inspector")}
          />
          <pre className="section-content">{selected ? JSON.stringify(messages[selected]?.data ?? "等待数据…", null, 2) : "从左侧选择一个 Topic"}</pre>
        </section>
      </section>
      <ResizeHandle
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
      />
      <ResizeHandle
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
      />
    </main>
  );
}
