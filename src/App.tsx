import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { BridgeClient } from "./bridge";
import { MotorControl } from "./MotorControl";
import type { AgentServiceStatus, BridgeEnvelope, ConnectionProfile, HardwareStatus, TopicInfo } from "./types";
import { UrdfViewer } from "./UrdfViewer";
import { loadPanelState, loadProfile, nextTopicSample } from "./appLogic";
import type { CollapsiblePanel, PanelState, TopicSample } from "./appLogic";

type Stage = "idle" | "ssh" | "tunnel" | "bridge" | "connected" | "failed";

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
  className = "",
}: {
  title: string;
  meta: string;
  expanded: boolean;
  onToggle(): void;
  className?: string;
}) {
  return (
    <div className={`panel-title ${className}`}>
      <strong>{title}</strong>
      <div className="panel-title-actions">
        <span className="panel-meta">{meta}</span>
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
  const [controlStreaming, setControlStreaming] = useState(false);
  const [effectiveLocalPort, setEffectiveLocalPort] = useState<number | null>(null);
  const [panels, setPanels] = useState<PanelState>(loadPanelState);
  const bridge = useMemo(() => new BridgeClient(), []);

  useEffect(() => {
    localStorage.setItem("easy-debug-panels", JSON.stringify(panels));
  }, [panels]);

  const togglePanel = (panel: CollapsiblePanel) => {
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

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
          <div className="brand"><span className="brand-mark">ED</span><div><h1>Easy Debug</h1><p>ROS 2 机器人调试工作台</p></div></div>
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
    <main className={`workspace ${panels.topics ? "" : "topics-collapsed"}`}>
      <header>
        <div className="brand compact"><span className="brand-mark">ED</span><strong>Easy Debug</strong></div>
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
      <aside className="topic-sidebar">
        <PanelTitle title="Topics" meta={String(topics.length)} expanded={panels.topics} onToggle={() => togglePanel("topics")} />
        <div className="topic-list">{topics.map((topic) => <button key={topic.name} className={selected === topic.name ? "active" : ""} onClick={() => selectTopic(topic)}><strong>{topic.name}</strong><small>{topic.types.join(", ")}</small></button>)}</div>
        {!panels.topics && <button className="collapsed-rail-label" type="button" onClick={() => togglePanel("topics")}>Topics</button>}
      </aside>
      <section className="urdf-panel"><div className="panel-title">Robot View <span>{profile.urdfTopic}</span></div><UrdfViewer xml={urdf} jointState={jointState} bridge={bridge} /></section>
      <section className={`data-panel ${panels.inspector ? "" : "inspector-collapsed"}`}>
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
    </main>
  );
}
