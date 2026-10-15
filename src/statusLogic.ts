import type { AgentServiceStatus, ConnectionProfile, HardwareStatus, RosControlStatus } from "./types";
import { defaultProfile } from "./types";
import { domainMismatchHint, isAgentOnline, isRosReady } from "./appLogic";
import type { TopicSample } from "./appLogic";
import { motorFaults, modes } from "./motorLogic";

export type StatusTone = "ok" | "warn" | "fail" | "idle" | "unknown";

export type BridgeHelloInfo = {
  bridgeVersion?: string;
  bridgeBuildId?: string;
  rosDistro?: string;
};

export type StatusRow = {
  label: string;
  value: string;
  tone?: StatusTone;
};

export type StatusCardModel = {
  id: string;
  title: string;
  tone: StatusTone;
  summary: string;
  rows: StatusRow[];
  note?: string;
};

export function toneLabel(tone: StatusTone): string {
  switch (tone) {
    case "ok":
      return "正常";
    case "warn":
      return "注意";
    case "fail":
      return "异常";
    case "unknown":
      return "未知";
    default:
      return "空闲";
  }
}

export function formatHz(hz: number | undefined): string {
  if (hz == null || !Number.isFinite(hz) || hz <= 0) return "—";
  if (hz >= 100) return `${Math.round(hz)} Hz`;
  if (hz >= 10) return `${hz.toFixed(1)} Hz`;
  return `${hz.toFixed(2)} Hz`;
}

export function formatHardwareMode(status: HardwareStatus | null): string {
  if (!status) return "—";
  if (status.mode_name && status.mode_name.trim()) return status.mode_name;
  if (typeof status.mode === "number") {
    const known = modes.find((entry) => entry.value === status.mode);
    if (known) return known.label;
    return `mode ${status.mode}`;
  }
  return "—";
}

export function formatFaultCode(faultCode: number | undefined): string {
  if (faultCode == null || !Number.isFinite(faultCode)) return "—";
  const info = motorFaults[faultCode];
  if (!info) return String(faultCode);
  return faultCode === 0 ? `0 · ${info.name}` : `${faultCode} · ${info.name}`;
}

export function formatAgentSummary(agent: AgentServiceStatus | null, agentError: string, agentChecked: boolean): {
  tone: StatusTone;
  summary: string;
} {
  if (!agentChecked && !agent && !agentError) {
    return { tone: "idle", summary: "检查中…" };
  }
  if (agentError) return { tone: "fail", summary: "检查失败" };
  if (isAgentOnline(agent)) return { tone: "ok", summary: "运行中" };
  if (agent) return { tone: "warn", summary: "未运行" };
  return { tone: "unknown", summary: "未知" };
}

export function activeControllers(rosControl: RosControlStatus | null): string[] {
  if (!rosControl?.available) return [];
  return rosControl.controllers.filter((controller) => controller.state === "active").map((controller) => controller.name);
}

export function buildStatusCards(input: {
  stage: string;
  sshOk: boolean;
  bridgeUp: boolean;
  localPort: number | null;
  remotePort: number;
  profile: ConnectionProfile;
  hello: BridgeHelloInfo | null;
  agentStatus: AgentServiceStatus | null;
  agentError: string;
  agentChecked: boolean;
  hardwareStatus: HardwareStatus | null;
  jointState: unknown;
  jointStateSample: TopicSample | undefined;
  jointStateTopic: string;
  rosControl: RosControlStatus | null;
  lastKnownDomainId: number | null;
}): StatusCardModel[] {
  const {
    stage,
    sshOk,
    bridgeUp,
    localPort,
    remotePort,
    profile,
    hello,
    agentStatus,
    agentError,
    agentChecked,
    hardwareStatus,
    jointState,
    jointStateSample,
    jointStateTopic,
    rosControl,
    lastKnownDomainId,
  } = input;

  const sessionUp = stage === "connected" || sshOk;
  const tunnelPort = localPort ?? profile.localPort;
  const sshCard: StatusCardModel = {
    id: "ssh",
    title: "SSH / 隧道",
    tone: stage === "connected" || (sshOk && bridgeUp) ? "ok" : sshOk ? "warn" : stage === "failed" ? "fail" : "idle",
    summary: sessionUp ? (stage === "connected" ? "会话已建立" : "SSH 已通过") : stage === "failed" ? "未建立" : "未连接",
    rows: [
      { label: "会话", value: stage === "connected" ? "已连接" : sessionUp ? "进行中" : "未连接", tone: stage === "connected" ? "ok" : "idle" },
      { label: "本地转发", value: `localhost:${tunnelPort}`, tone: stage === "connected" ? "ok" : "idle" },
      { label: "远端端口", value: String(remotePort) },
      { label: "主机", value: `${profile.host}${profile.username ? ` · ${profile.username}` : ""}` },
    ],
  };

  const bridgeConnected = bridgeUp || stage === "connected";
  const versionText = hello?.bridgeVersion
    ? `${hello.bridgeVersion}${hello.bridgeBuildId ? ` (${hello.bridgeBuildId})` : ""}`
    : "未知（等待 hello）";
  const bridgeCard: StatusCardModel = {
    id: "bridge",
    title: "Bridge",
    tone: bridgeConnected ? "ok" : stage === "failed" ? "fail" : "idle",
    summary: bridgeConnected ? "WebSocket 已连接" : "未连接",
    rows: [
      { label: "WS", value: bridgeConnected ? "已连接" : "未连接", tone: bridgeConnected ? "ok" : "idle" },
      { label: "bridge_version", value: hello?.bridgeVersion ?? "未知", tone: hello?.bridgeVersion ? "ok" : "unknown" },
      { label: "bridge_build_id", value: hello?.bridgeBuildId ?? "未知", tone: hello?.bridgeBuildId ? "ok" : "unknown" },
      { label: "ros_distro", value: hello?.rosDistro ?? "未知", tone: hello?.rosDistro ? "ok" : "unknown" },
      { label: "监听期望", value: `127.0.0.1:${remotePort}` },
      { label: "最近部署", value: "未知", tone: "unknown" },
    ],
    note: hello ? `版本：${versionText}` : "hello 尚未收到；版本字段待 Bridge 回包。部署结果不由本页持久化。",
  };

  const agent = formatAgentSummary(agentStatus, agentError, agentChecked);
  const agentCard: StatusCardModel = {
    id: "agent",
    title: "micro-ROS Agent",
    tone: agent.tone,
    summary: agent.summary,
    rows: [
      { label: "服务", value: "micro-ros-agent-stm32h723.service" },
      { label: "Active", value: agentStatus ? `${agentStatus.activeState}/${agentStatus.subState}` : agentError ? "检查失败" : "—", tone: agent.tone },
      { label: "PID", value: agentStatus?.mainPid ? String(agentStatus.mainPid) : "—" },
      { label: "开机", value: agentStatus?.unitFileState || "—" },
      { label: "XRCE 端口 / 会话", value: "未知", tone: "unknown" },
    ],
    note: agentError || agentStatus?.description || undefined,
  };

  const hardwareReceived = Boolean(hardwareStatus);
  const faultCode = hardwareStatus?.fault_code;
  const faultTone: StatusTone = !hardwareReceived
    ? "idle"
    : faultCode == null
      ? "unknown"
      : faultCode === 0
        ? "ok"
        : "fail";
  const hardwareCard: StatusCardModel = {
    id: "hardware",
    title: "Hardware",
    tone: hardwareReceived ? (faultCode && faultCode !== 0 ? "fail" : "ok") : bridgeConnected ? "warn" : "idle",
    summary: hardwareReceived ? "已收到 HardwareStatus" : "未收到",
    rows: [
      { label: "HardwareStatus", value: hardwareReceived ? "已收到" : "未收到", tone: hardwareReceived ? "ok" : "idle" },
      { label: "fault_code", value: formatFaultCode(faultCode), tone: faultTone },
      { label: "mode", value: formatHardwareMode(hardwareStatus), tone: hardwareReceived ? "ok" : "idle" },
      {
        label: "JointState",
        value: isRosReady(jointState) ? "有数据" : "未流动",
        tone: isRosReady(jointState) ? "ok" : "idle",
      },
    ],
  };

  const rosReady = isRosReady(jointState);
  const hz = jointStateSample?.hz;
  const count = jointStateSample?.count;
  const rosReadyCard: StatusCardModel = {
    id: "ros-ready",
    title: "ROS 就绪",
    tone: rosReady ? "ok" : bridgeConnected ? "warn" : "idle",
    summary: rosReady ? "JointState 冒烟通过" : "等待 JointState",
    rows: [
      { label: "Topic", value: jointStateTopic },
      { label: "冒烟", value: rosReady ? "已收到" : "未收到", tone: rosReady ? "ok" : "idle" },
      { label: "频率", value: formatHz(hz), tone: hz && hz > 0 ? "ok" : "idle" },
      { label: "累计", value: count != null && count > 0 ? String(count) : "—" },
    ],
  };

  const actives = activeControllers(rosControl);
  const rosControlTone: StatusTone = !rosControl
    ? "idle"
    : !rosControl.available
      ? "fail"
      : actives.length > 0
        ? "ok"
        : "warn";
  const rosControlCard: StatusCardModel = {
    id: "ros2-control",
    title: "ros2_control",
    tone: rosControlTone,
    summary: !rosControl
      ? "检查中…"
      : !rosControl.available
        ? "Controller Manager 离线"
        : actives.length > 0
          ? `${actives.length} 个 active`
          : "无 active Controller",
    rows: [
      { label: "Manager", value: rosControl?.manager ?? "/controller_manager" },
      { label: "可用", value: rosControl ? (rosControl.available ? "是" : "否") : "—", tone: rosControl?.available ? "ok" : rosControl ? "fail" : "idle" },
      { label: "Active", value: actives.length > 0 ? actives.join(", ") : "—", tone: actives.length > 0 ? "ok" : "idle" },
      { label: "全部", value: rosControl?.available ? String(rosControl.controllers.length) : "—" },
    ],
    note: rosControl?.message || undefined,
  };

  const domainHint = domainMismatchHint(profile.rosDomainId, lastKnownDomainId, defaultProfile.rosDomainId);
  const domainCard: StatusCardModel = {
    id: "dds",
    title: "DDS Domain",
    tone: domainHint ? "warn" : "ok",
    summary: `ROS_DOMAIN_ID=${profile.rosDomainId}`,
    rows: [
      { label: "当前", value: String(profile.rosDomainId), tone: domainHint ? "warn" : "ok" },
      { label: "默认", value: String(defaultProfile.rosDomainId) },
      { label: "上次成功", value: lastKnownDomainId == null ? "—" : String(lastKnownDomainId) },
      { label: "提示", value: domainHint || "与默认一致", tone: domainHint ? "warn" : "ok" },
    ],
  };

  const systemdCard: StatusCardModel = {
    id: "systemd",
    title: "systemd",
    tone: agentStatus ? (isAgentOnline(agentStatus) ? "ok" : "warn") : agentError ? "fail" : "unknown",
    summary: "Agent 可查；Bridge 单元未探测",
    rows: [
      {
        label: "Agent 单元",
        value: agentStatus ? `${agentStatus.activeState}/${agentStatus.subState}` : agentError ? "检查失败" : "未知",
        tone: agentStatus ? (isAgentOnline(agentStatus) ? "ok" : "warn") : agentError ? "fail" : "unknown",
      },
      { label: "Agent journal", value: agentStatus?.description || agentError || "未知", tone: agentStatus?.description ? "ok" : "unknown" },
      { label: "Bridge 单元", value: "未知（未探测）", tone: "unknown" },
      { label: "Bridge journal", value: "未知", tone: "unknown" },
    ],
    note: "仅复用现有 check_micro_ros_agent；不新增 SSH journal 调用。",
  };

  const usbCard: StatusCardModel = {
    id: "usb",
    title: "USB CDC / 传输",
    tone: "unknown",
    summary: "未知",
    rows: [
      { label: "USB CDC", value: "未知", tone: "unknown" },
      { label: "传输流", value: "未知", tone: "unknown" },
    ],
    note: "当前无现成探测 API；有检测后再接入。",
  };

  return [sshCard, bridgeCard, agentCard, hardwareCard, rosReadyCard, rosControlCard, domainCard, systemdCard, usbCard];
}
