import type {
  AgentServiceStatus,
  ArmModeStatus,
  ConnectionProfile,
  HardwareStatus,
  RosControlStatus,
  UsbProbeStatus,
} from "./types";
import { defaultProfile } from "./types";
import { domainMismatchHint, isAgentOnline, isRosReady } from "./appLogic";
import type { TopicSample } from "./appLogic";
import { motorFaults, modes } from "./motorLogic";
import {
  GRAVITY_COMPENSATION_CONTROLLER,
  VLA_CHUNK_TOPIC,
  VLA_POSITION_CONTROLLER,
  isGravityCompensationActive,
  isVlaControllerActive,
} from "./vlaLogic";

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

export type StatusCardAction = {
  id: string;
  label: string;
  kind: "restart" | "refresh" | "stop";
  disabled?: boolean;
  disabledReason?: string;
};

export type StatusCardModel = {
  id: string;
  title: string;
  tone: StatusTone;
  summary: string;
  rows: StatusRow[];
  note?: string;
  detail?: string;
  failureReason?: string;
  /** Visible caution banner (HOLD / VLA risk), distinct from failureReason. */
  warning?: string;
  actions?: StatusCardAction[];
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


/** True when firmware reports HOLD (mode 0 / mode_name HOLD). */
export function isHardwareHold(status: HardwareStatus | null | undefined): boolean {
  if (!status) return false;
  const name = status.mode_name?.trim().toUpperCase();
  if (name === "HOLD") return true;
  if (name) return false;
  return status.mode === 0;
}

export const HOLD_NO_GRAVITY_HINT = "无重力补偿，可能下垂";

/** Short Status warning: desk-launched teleop may tear down ros2_control when starting VLA. */
export const VLA_ONE_CLICK_RISK_WARNING =
  "注意：若 ros2_control 由 Desk 一键 Teleop/Trajectory 拉起，点「启动/一键 VLA」可能一并拆掉 Controller Manager。请先在 Jetson 独立启动后再切 VLA。详见 PR #102 / docs/vla.md。";

export function formatFaultCode(faultCode: number | undefined): string {
  if (faultCode == null || !Number.isFinite(faultCode)) return "—";
  const info = motorFaults[faultCode];
  if (!info) return String(faultCode);
  return faultCode === 0 ? `0 · ${info.name}` : `${faultCode} · ${info.name}`;
}

export function faultFailureReason(faultCode: number | undefined): string | undefined {
  if (faultCode == null || !Number.isFinite(faultCode) || faultCode === 0) return undefined;
  const info = motorFaults[faultCode];
  return info?.description ?? `未知故障码 ${faultCode}`;
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

export function buildUsbCard(input: {
  sshOk: boolean;
  usbProbe: UsbProbeStatus | null;
  usbChecked: boolean;
}): StatusCardModel {
  const { sshOk, usbProbe, usbChecked } = input;
  const refreshAction: StatusCardAction = {
    id: "usb-refresh",
    label: "刷新检测",
    kind: "refresh",
    disabled: !sshOk,
    disabledReason: sshOk ? undefined : "SSH 未就绪",
  };

  if (!sshOk) {
    return {
      id: "usb",
      title: "USB CDC / 传输",
      tone: "fail",
      summary: "SSH 未就绪",
      failureReason: "无法探测 USB：SSH 未连接或失败",
      rows: [
        { label: "MCU CDC", value: "—", tone: "idle" },
        { label: "串口", value: "—" },
        { label: "RealSense USB", value: "—", tone: "idle" },
      ],
      actions: [refreshAction],
    };
  }

  if (!usbChecked && !usbProbe) {
    return {
      id: "usb",
      title: "USB CDC / 传输",
      tone: "idle",
      summary: "检查中…",
      rows: [
        { label: "MCU CDC", value: "检查中…", tone: "idle" },
        { label: "串口", value: "—" },
        { label: "RealSense USB", value: "检查中…", tone: "idle" },
      ],
      actions: [refreshAction],
    };
  }

  if (usbProbe?.error) {
    return {
      id: "usb",
      title: "USB CDC / 传输",
      tone: "fail",
      summary: "探测失败",
      failureReason: usbProbe.error,
      rows: [
        { label: "MCU CDC", value: "探测失败", tone: "fail" },
        { label: "串口", value: "—" },
        { label: "RealSense USB", value: "探测失败", tone: "fail" },
      ],
      actions: [refreshAction],
    };
  }

  const mcuOk = Boolean(usbProbe?.mcuPresent);
  const rsOk = Boolean(usbProbe?.realsensePresent);
  const tone: StatusTone = mcuOk ? "ok" : "fail";
  const serial = usbProbe?.serialPath?.trim() || "";
  const vidPid = usbProbe?.mcuVidPid || "0483:5740";
  return {
    id: "usb",
    title: "USB CDC / 传输",
    tone,
    summary: mcuOk ? `MCU 已识别 · ${vidPid}` : "MCU 未插",
    detail: mcuOk
      ? `STM32 Virtual ComPort ${vidPid}${serial ? ` · ${serial}` : ""}`
      : undefined,
    failureReason: mcuOk ? undefined : "未检测到 VID:PID 0483:5740（STM32 Virtual ComPort）",
    rows: [
      { label: "MCU CDC", value: mcuOk ? `已识别 · ${vidPid}` : "未插", tone: mcuOk ? "ok" : "fail" },
      { label: "串口", value: serial || (mcuOk ? "未知" : "—"), tone: serial ? "ok" : "unknown" },
      {
        label: "RealSense USB",
        value: rsOk ? `已识别 · Intel 8086${usbProbe?.realsenseLines?.[0] ? ` · ${usbProbe.realsenseLines[0]}` : ""}` : "未插",
        tone: rsOk ? "ok" : "warn",
      },
    ],
    note: usbProbe?.rawLsusb ? `lsusb 摘录：${usbProbe.rawLsusb.split("\n").filter(Boolean).slice(0, 3).join(" · ")}` : undefined,
    actions: [refreshAction],
  };
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
  usbProbe?: UsbProbeStatus | null;
  usbChecked?: boolean;
  armMode?: ArmModeStatus | null;
  realsenseTopicSample?: TopicSample | undefined;
  vlaChunkSample?: TopicSample | undefined;
  actionBusy?: string | null;
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
    usbProbe = null,
    usbChecked = false,
    armMode = null,
    realsenseTopicSample,
    vlaChunkSample,
    actionBusy = null,
  } = input;

  const sessionUp = stage === "connected" || sshOk;
  const tunnelPort = localPort ?? profile.localPort;
  const rosReady = isRosReady(jointState);
  const armGateOk = sshOk && rosReady;
  const armGateReason = !sshOk ? "SSH 未就绪" : !rosReady ? "等待 JointState（ROS 未就绪）" : undefined;
  const busy = (id: string) => actionBusy === id;

  const sshCard: StatusCardModel = {
    id: "ssh",
    title: "SSH / 隧道",
    tone: stage === "connected" || (sshOk && bridgeUp) ? "ok" : sshOk ? "warn" : stage === "failed" ? "fail" : "idle",
    summary: sessionUp ? (stage === "connected" ? "会话已建立" : "SSH 已通过") : stage === "failed" ? "未建立" : "未连接",
    detail: sessionUp ? `localhost:${tunnelPort} → ${profile.host}:${remotePort}` : undefined,
    failureReason: stage === "failed" ? "SSH 或隧道未建立" : undefined,
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
    detail: bridgeConnected && hello?.bridgeVersion ? `版本 ${versionText}` : undefined,
    failureReason: !bridgeConnected && stage === "failed" ? "Bridge WebSocket 未连接" : undefined,
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
  const agentOnline = isAgentOnline(agentStatus);
  const agentCard: StatusCardModel = {
    id: "agent",
    title: "micro-ROS Agent",
    tone: agent.tone,
    summary: agent.summary,
    detail: agentOnline && agentStatus
      ? `${agentStatus.activeState}/${agentStatus.subState} · PID ${agentStatus.mainPid || "—"} · ${agentStatus.unitFileState || "—"}`
      : undefined,
    failureReason: agentError
      ? agentError
      : agentStatus && !agentOnline
        ? `服务未运行（${agentStatus.activeState}/${agentStatus.subState}）`
        : undefined,
    rows: [
      { label: "服务", value: "micro-ros-agent-stm32h723.service" },
      { label: "Active", value: agentStatus ? `${agentStatus.activeState}/${agentStatus.subState}` : agentError ? "检查失败" : "—", tone: agent.tone },
      { label: "PID", value: agentStatus?.mainPid ? String(agentStatus.mainPid) : "—" },
      { label: "开机", value: agentStatus?.unitFileState || "—" },
      { label: "XRCE 端口 / 会话", value: "未知", tone: "unknown" },
    ],
    note: agentError || agentStatus?.description || undefined,
    actions: [
      {
        id: "agent-restart",
        label: busy("agent-restart") ? "拉起中…" : "重新拉起",
        kind: "restart",
        disabled: !sshOk || busy("agent-restart"),
        disabledReason: !sshOk ? "SSH 未就绪" : busy("agent-restart") ? "操作进行中" : undefined,
      },
    ],
  };

  const hardwareReceived = Boolean(hardwareStatus);
  const faultCode = hardwareStatus?.fault_code;
  const holdNoFault = hardwareReceived && faultCode === 0 && isHardwareHold(hardwareStatus);
  const faultTone: StatusTone = !hardwareReceived
    ? "idle"
    : faultCode == null
      ? "unknown"
      : faultCode === 0
        ? holdNoFault
          ? "warn"
          : "ok"
        : "fail";
  const modeLabel = formatHardwareMode(hardwareStatus);
  let hardwareTone: StatusTone = "idle";
  if (hardwareReceived) {
    hardwareTone = faultCode && faultCode !== 0 ? "fail" : holdNoFault ? "warn" : "ok";
  } else if (bridgeConnected) {
    hardwareTone = "warn";
  }
  const hardwareCard: StatusCardModel = {
    id: "hardware",
    title: "Hardware",
    tone: hardwareTone,
    summary: hardwareReceived ? "已收到 HardwareStatus" : "未收到",
    detail: hardwareReceived && faultCode === 0
      ? (holdNoFault ? `HOLD · ${HOLD_NO_GRAVITY_HINT}` : `无故障 · ${modeLabel}`)
      : hardwareReceived ? `${modeLabel}` : undefined,
    failureReason: faultFailureReason(faultCode),
    warning: holdNoFault ? HOLD_NO_GRAVITY_HINT : undefined,
    rows: [
      { label: "HardwareStatus", value: hardwareReceived ? "已收到" : "未收到", tone: hardwareReceived ? "ok" : "idle" },
      { label: "fault_code", value: formatFaultCode(faultCode), tone: faultTone },
      { label: "mode", value: modeLabel, tone: hardwareReceived ? (holdNoFault ? "warn" : "ok") : "idle" },
      {
        label: "JointState",
        value: rosReady ? "有数据" : "未流动",
        tone: rosReady ? "ok" : "idle",
      },
    ],
  };

  const hz = jointStateSample?.hz;
  const count = jointStateSample?.count;
  const rosReadyCard: StatusCardModel = {
    id: "ros-ready",
    title: "ROS 就绪",
    tone: rosReady ? "ok" : bridgeConnected ? "warn" : "idle",
    summary: rosReady ? "JointState 冒烟通过" : "等待 JointState",
    detail: rosReady ? `${jointStateTopic} · ${formatHz(hz)}` : undefined,
    failureReason: bridgeConnected && !rosReady ? "尚未收到 JointState，Monitor/Motor 与 Teleop/Trajectory 一键启动暂不可用" : undefined,
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
    detail: actives.length > 0 ? actives.join(", ") : undefined,
    failureReason: rosControl && !rosControl.available ? rosControl.message || "Controller Manager 不可用" : undefined,
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
    detail: domainHint || "与默认一致",
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
    detail: agentStatus ? `Agent ${agentStatus.activeState}/${agentStatus.subState}` : undefined,
    failureReason: agentError || undefined,
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
    note: "Agent 重启走 systemctl restart；不刷写固件。",
  };

  const usbCard = buildUsbCard({ sshOk, usbProbe, usbChecked });

  const teleopRunning = Boolean(armMode?.teleopRunning);
  const teleopCard: StatusCardModel = {
    id: "teleop",
    title: "Teleop",
    tone: !sshOk ? "idle" : teleopRunning ? "ok" : "warn",
    summary: !sshOk ? "SSH 未就绪" : teleopRunning ? "运行中" : "未运行",
    detail: teleopRunning && armMode?.teleopPid ? `PID ${armMode.teleopPid} · start_arm_teleop.sh --position-controller=teleop` : teleopRunning ? "start_arm_teleop.sh --position-controller=teleop" : undefined,
    failureReason: sshOk && !teleopRunning ? "Teleop 未拉起（可通过一键启动）" : undefined,
    rows: [
      { label: "状态", value: teleopRunning ? "运行中" : "未运行", tone: teleopRunning ? "ok" : "idle" },
      { label: "PID", value: armMode?.teleopPid ? String(armMode.teleopPid) : "—" },
      { label: "脚本", value: "scripts/start_arm_teleop.sh" },
      { label: "控制器", value: "teleop" },
    ],
    note: armMode?.message || "切换前会先 HOLD；与 Trajectory 互斥。",
    actions: [
      {
        id: "teleop-restart",
        label: busy("teleop-restart") ? "拉起中…" : "重新拉起",
        kind: "restart",
        disabled: !armGateOk || busy("teleop-restart") || busy("vla-start") || busy("vla-stop") || isVlaControllerActive(rosControl),
        disabledReason: armGateReason
          || (isVlaControllerActive(rosControl) ? "先停止 VLA" : undefined)
          || (busy("teleop-restart") || busy("vla-start") || busy("vla-stop") ? "操作进行中" : undefined),
      },
    ],
  };

  const trajRunning = Boolean(armMode?.trajectoryRunning);
  const trajectoryCard: StatusCardModel = {
    id: "trajectory",
    title: "Trajectory / MoveIt",
    tone: !sshOk ? "idle" : trajRunning ? "ok" : "warn",
    summary: !sshOk ? "SSH 未就绪" : trajRunning ? "运行中" : "未运行",
    detail: trajRunning
      ? `PID ${armMode?.trajectoryPid || "—"} · move_group / trajectory controller`
      : undefined,
    failureReason: sshOk && !trajRunning ? "Trajectory/MoveIt 未拉起（可通过一键启动）" : undefined,
    rows: [
      { label: "状态", value: trajRunning ? "运行中" : "未运行", tone: trajRunning ? "ok" : "idle" },
      { label: "PID", value: armMode?.trajectoryPid ? String(armMode.trajectoryPid) : "—" },
      { label: "启动", value: "move_group.launch.py 或 teleop --position-controller=trajectory" },
      { label: "互斥", value: "与 Teleop 互斥" },
    ],
    note: "切换前会先 HOLD；停止上一进程组后再启动。",
    actions: [
      {
        id: "trajectory-restart",
        label: busy("trajectory-restart") ? "拉起中…" : "重新拉起",
        kind: "restart",
        disabled: !armGateOk || busy("trajectory-restart") || busy("vla-start") || busy("vla-stop") || isVlaControllerActive(rosControl),
        disabledReason: armGateReason
          || (isVlaControllerActive(rosControl) ? "先停止 VLA" : undefined)
          || (busy("trajectory-restart") || busy("vla-start") || busy("vla-stop") ? "操作进行中" : undefined),
      },
    ],
  };

  const rsUsb = Boolean(usbProbe?.realsensePresent);
  const rsNode = Boolean(armMode?.realsenseRunning);
  const rsHz = realsenseTopicSample?.hz;
  const rsTopicOk = Boolean(rsHz && rsHz > 0);
  let rsTone: StatusTone = "idle";
  let rsSummary = "未知";
  let rsFailure: string | undefined;
  let rsDetail: string | undefined;
  if (!sshOk) {
    rsTone = "idle";
    rsSummary = "SSH 未就绪";
  } else if (!usbChecked && !usbProbe) {
    rsTone = "idle";
    rsSummary = "检查中…";
  } else if (!rsUsb) {
    rsTone = "fail";
    rsSummary = "无 USB";
    rsFailure = "未检测到 Intel RealSense（lsusb 8086:*）";
  } else if (rsNode || rsTopicOk) {
    rsTone = "ok";
    rsSummary = rsTopicOk ? `运行中 · ${formatHz(rsHz)}` : "节点运行中";
    rsDetail = rsTopicOk
      ? `/camera/camera/color/image_raw · ${formatHz(rsHz)}`
      : "USB 已识别且 RealSense 节点在跑";
  } else {
    rsTone = "warn";
    rsSummary = "USB 有 · 无 Topic/节点";
    rsFailure = "USB 已识别，但未检测到 RealSense 节点或图像 Topic；可一键拉起 rs_launch.py";
  }
  const realsenseCard: StatusCardModel = {
    id: "realsense",
    title: "RealSense",
    tone: rsTone,
    summary: rsSummary,
    detail: rsDetail,
    failureReason: rsFailure,
    rows: [
      { label: "USB 8086", value: rsUsb ? "已识别" : "未插", tone: rsUsb ? "ok" : "fail" },
      { label: "节点", value: rsNode ? "运行中" : "未运行", tone: rsNode ? "ok" : "idle" },
      { label: "图像 Topic", value: rsTopicOk ? formatHz(rsHz) : "无采样", tone: rsTopicOk ? "ok" : "idle" },
      { label: "PID", value: armMode?.realsensePid ? String(armMode.realsensePid) : "—" },
    ],
    note: "重启使用 ros2 launch realsense2_camera rs_launch.py；不写入 ros2-stack。",
    actions: [
      {
        id: "realsense-restart",
        label: busy("realsense-restart") ? "拉起中…" : "重新拉起",
        kind: "restart",
        disabled: !sshOk || busy("realsense-restart"),
        disabledReason: !sshOk ? "SSH 未就绪" : busy("realsense-restart") ? "操作进行中" : undefined,
      },
    ],
  };


  const vlaActive = isVlaControllerActive(rosControl);
  const gravityOn = isGravityCompensationActive(rosControl);
  const vlaHz = vlaChunkSample?.hz;
  const vlaChunkOk = Boolean(vlaHz && vlaHz > 0);
  let vlaTone: StatusTone = "idle";
  let vlaSummary = "未知";
  let vlaDetail: string | undefined;
  let vlaFailure: string | undefined;
  if (!sshOk) {
    vlaTone = "idle";
    vlaSummary = "SSH 未就绪";
  } else if (!rosControl) {
    vlaTone = "idle";
    vlaSummary = "检查中…";
  } else if (!rosControl.available) {
    vlaTone = "fail";
    vlaSummary = "Controller Manager 离线";
    vlaFailure = rosControl.message || "无法查询控制器，无法判断 VLA 状态";
  } else if (vlaActive) {
    vlaTone = "ok";
    vlaSummary = vlaChunkOk ? `运行中 · ${formatHz(vlaHz)}` : "控制器 active";
    vlaDetail = vlaChunkOk
      ? `${VLA_POSITION_CONTROLLER} · ${VLA_CHUNK_TOPIC} ${formatHz(vlaHz)}`
      : `${VLA_POSITION_CONTROLLER} active · 等待 ${VLA_CHUNK_TOPIC}`;
  } else {
    vlaTone = "warn";
    vlaSummary = "未运行";
    vlaFailure = "vla_position_controller 未激活（可通过一键启动；与 arm_teleop / arm_trajectory 互斥）";
  }
  const vlaBusy = busy("vla-start") || busy("vla-stop");
  const vlaCard: StatusCardModel = {
    id: "vla",
    title: "VLA",
    tone: vlaTone,
    summary: vlaSummary,
    detail: vlaDetail,
    failureReason: vlaFailure,
    rows: [
      {
        label: "控制器",
        value: vlaActive ? "active" : rosControl?.available ? "inactive" : "—",
        tone: vlaActive ? "ok" : "idle",
      },
      { label: "名称", value: VLA_POSITION_CONTROLLER },
      {
        label: "Chunk Topic",
        value: vlaChunkOk ? formatHz(vlaHz) : VLA_CHUNK_TOPIC,
        tone: vlaChunkOk ? "ok" : "idle",
      },
      {
        label: "Gravity",
        value: gravityOn ? "active" : "未激活",
        tone: gravityOn ? "ok" : "warn",
      },
    ],
    note: `Scheme B：外部推理 → ${VLA_CHUNK_TOPIC} → ${VLA_POSITION_CONTROLLER}；并行 ${GRAVITY_COMPENSATION_CONTROLLER}；互斥 arm_teleop_controller / arm_trajectory_controller。Desk 不直写 /stm32/joint_commands。`,
    warning: VLA_ONE_CLICK_RISK_WARNING,
    actions: [
      {
        id: "vla-start",
        label: busy("vla-start") ? "启动中…" : "启动 VLA",
        kind: "restart",
        disabled: !armGateOk || vlaBusy || vlaActive,
        disabledReason: armGateReason
          || (vlaActive ? "VLA 已在运行" : undefined)
          || (vlaBusy ? "操作进行中" : undefined),
      },
      {
        id: "vla-stop",
        label: busy("vla-stop") ? "停止中…" : "停止 VLA",
        kind: "stop",
        disabled: !sshOk || vlaBusy || !vlaActive,
        disabledReason: !sshOk
          ? "SSH 未就绪"
          : !vlaActive
            ? "VLA 未运行"
            : vlaBusy
              ? "操作进行中"
              : undefined,
      },
    ],
  };

  return [
    sshCard,
    bridgeCard,
    agentCard,
    hardwareCard,
    rosReadyCard,
    rosControlCard,
    domainCard,
    systemdCard,
    usbCard,
    teleopCard,
    trajectoryCard,
    vlaCard,
    realsenseCard,
  ];
}

export type StatusQuickAction = {
  id: "teleop" | "trajectory" | "vla" | "stop";
  label: string;
  disabled?: boolean;
  disabledReason?: string;
};

export function buildStatusQuickActions(input: {
  sshOk: boolean;
  rosReady: boolean;
  actionBusy?: string | null;
  vlaActive?: boolean;
}): StatusQuickAction[] {
  const gateOk = input.sshOk && input.rosReady;
  const reason = !input.sshOk ? "SSH 未就绪" : !input.rosReady ? "等待 JointState" : undefined;
  const busy = input.actionBusy;
  const modeBusy = busy === "teleop-restart" || busy === "trajectory-restart" || busy === "vla-start" || busy === "vla-stop" || busy === "arm-stop";
  const vlaBlocks = Boolean(input.vlaActive);
  return [
    {
      id: "teleop",
      label: busy === "teleop-restart" ? "启动 Teleop…" : "一键 Teleop",
      disabled: !gateOk || modeBusy || vlaBlocks,
      disabledReason: reason || (vlaBlocks ? "先停止 VLA" : undefined) || (modeBusy ? "操作进行中" : undefined),
    },
    {
      id: "trajectory",
      label: busy === "trajectory-restart" ? "启动 Trajectory…" : "一键 Trajectory",
      disabled: !gateOk || modeBusy || vlaBlocks,
      disabledReason: reason || (vlaBlocks ? "先停止 VLA" : undefined) || (modeBusy ? "操作进行中" : undefined),
    },
    {
      id: "vla",
      label: busy === "vla-start" ? "启动 VLA…" : "一键 VLA",
      disabled: !gateOk || modeBusy || vlaBlocks,
      disabledReason: reason || (vlaBlocks ? "VLA 已在运行" : undefined) || (modeBusy ? "操作进行中" : undefined),
    },
    {
      id: "stop",
      label: busy === "arm-stop" || busy === "vla-stop" ? "停止中…" : "停止 Teleop/Trajectory/VLA",
      disabled: !input.sshOk || busy === "arm-stop" || busy === "vla-stop",
      disabledReason: !input.sshOk ? "SSH 未就绪" : busy === "arm-stop" || busy === "vla-stop" ? "操作进行中" : undefined,
    },
  ];
}
