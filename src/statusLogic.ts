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
  ARM_TELEOP_CONTROLLER,
  ARM_TRAJECTORY_CONTROLLER,
  GRAVITY_COMPENSATION_CONTROLLER,
  VLA_CHUNK_TOPIC,
  VLA_POSITION_CONTROLLER,
  isArmTeleopControllerActive,
  isArmTrajectoryControllerActive,
  isGravityCompensationActive,
  isHardwareTrack,
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

export type StatusZoneId = "connection" | "hardware" | "control" | "sensors";

export type StatusZoneModel = {
  id: StatusZoneId;
  title: string;
  primary?: boolean;
  collapsedByDefault?: boolean;
  cards: StatusCardModel[];
};

export type StatusStickyAlert = {
  tone: "warn" | "fail";
  title: string;
  message: string;
  kind: "fault" | "hold" | "fault11";
};

export type ActiveControlMode = "teleop" | "trajectory" | "vla" | null;

export const STATUS_ZONE_META: Array<{
  id: StatusZoneId;
  title: string;
  primary?: boolean;
  collapsedByDefault?: boolean;
  cardIds: string[];
}> = [
  { id: "connection", title: "连接", cardIds: ["ssh", "bridge", "agent"] },
  { id: "hardware", title: "硬件健康", primary: true, cardIds: ["usb", "hardware", "ros2-control", "ros-ready"] },
  { id: "control", title: "控制模式", cardIds: ["teleop", "trajectory", "vla"] },
  { id: "sensors", title: "传感器", cardIds: ["realsense"] },
];

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

/** Short Status note: Start VLA skips tearing down owned ros2_control; unknown ownership refuses. */
export const VLA_ONE_CLICK_RISK_WARNING =
  "启动 VLA：若 Desk 一键 Teleop/Trajectory 持有 ros2_control，将跳过 stop、仅 switch_controllers；无法确认归属时拒绝启动。显式「停止」仍可拆除。详见 docs/vla.md。";

/** fault_code 11 hard-fail copy (no soft recovery). */
export const FAULT_11_HARD_FAIL_COPY = "需先安全回零/托住，再重启 STM32（无软恢复）";

/** True when HardwareStatus.fault_code === 11 (COMMAND_LOSS_LATCHED). */
export function isFault11Latched(status: { fault_code?: number } | null | undefined): boolean {
  return status?.fault_code === 11;
}

/** Disable Teleop/Trajectory/VLA start when fault 11 is latched. */
export function fault11StartBlockReason(status: { fault_code?: number } | null | undefined): string | undefined {
  return isFault11Latched(status) ? FAULT_11_HARD_FAIL_COPY : undefined;
}

/** Page-level sticky alert for fault≠0 / HOLD / fault 11. */
export function buildHardwareStickyAlert(status: HardwareStatus | null | undefined): StatusStickyAlert | null {
  if (!status) return null;
  const faultCode = status.fault_code;
  if (isFault11Latched(status)) {
    return {
      tone: "fail",
      kind: "fault11",
      title: "故障 11 · COMMAND_LOSS_LATCHED",
      message: FAULT_11_HARD_FAIL_COPY,
    };
  }
  if (faultCode != null && Number.isFinite(faultCode) && faultCode !== 0) {
    return {
      tone: "fail",
      kind: "fault",
      title: `故障 ${faultCode}`,
      message: faultFailureReason(faultCode) || formatFaultCode(faultCode),
    };
  }
  if (isHardwareHold(status)) {
    return {
      tone: "warn",
      kind: "hold",
      title: "HOLD",
      message: HOLD_NO_GRAVITY_HINT,
    };
  }
  return null;
}

export function formatLastCommandSequence(status: HardwareStatus | null | undefined): string {
  const seq = status?.last_command_sequence;
  if (seq == null || !Number.isFinite(seq)) return "—";
  return String(seq);
}

/**
 * Prefer active position controller from list_controllers when available
 * (VLA / Teleop / Trajectory), so strip selection stays consistent after
 * switch_controllers without stopping scripts (#106). Fall back to script
 * PID flags only when ros2_control data is missing.
 */
export function resolveActiveControlMode(input: {
  armMode?: ArmModeStatus | null;
  rosControl?: RosControlStatus | null;
}): ActiveControlMode {
  const rosControl = input.rosControl ?? null;
  if (rosControl?.available) {
    if (isVlaControllerActive(rosControl)) return "vla";
    if (isArmTeleopControllerActive(rosControl)) return "teleop";
    if (isArmTrajectoryControllerActive(rosControl)) return "trajectory";
    return null;
  }
  if (input.armMode?.teleopRunning) return "teleop";
  if (input.armMode?.trajectoryRunning) return "trajectory";
  return null;
}

/** Gravity row shared by Teleop / Trajectory / VLA mode detail. */
export function gravityCompensationRow(input: {
  rosControl: RosControlStatus | null | undefined;
  modeActive: boolean;
}): StatusRow {
  const rosControl = input.rosControl ?? null;
  if (!rosControl) {
    return { label: "Gravity", value: "—", tone: "idle" };
  }
  if (!rosControl.available) {
    return { label: "Gravity", value: "不可用", tone: "fail" };
  }
  const gravityOn = isGravityCompensationActive(rosControl);
  return {
    label: "Gravity",
    value: gravityOn ? `active · ${GRAVITY_COMPENSATION_CONTROLLER}` : `未激活 · ${GRAVITY_COMPENSATION_CONTROLLER}`,
    tone: gravityOn ? "ok" : input.modeActive ? "warn" : "idle",
  };
}

export function gravityInactiveWarning(modeActive: boolean, rosControl: RosControlStatus | null | undefined): string | undefined {
  if (!modeActive || !rosControl?.available) return undefined;
  if (isGravityCompensationActive(rosControl)) return undefined;
  return `${GRAVITY_COMPENSATION_CONTROLLER} 未激活（建议与位置控制器并行；Trajectory bring-up 尤其需要）`;
}

export function groupStatusZones(cards: StatusCardModel[]): StatusZoneModel[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return STATUS_ZONE_META.map((zone) => ({
    id: zone.id,
    title: zone.title,
    primary: zone.primary,
    collapsedByDefault: zone.collapsedByDefault,
    cards: zone.cardIds.map((id) => byId.get(id)).filter((card): card is StatusCardModel => Boolean(card)),
  }));
}

export function statusZoneForCard(cardId: string | null): StatusZoneId | undefined {
  return STATUS_ZONE_META.find((zone) => zone.cardIds.includes(cardId ?? ""))?.id;
}

export function summarizeStatusZone(cards: StatusCardModel[]): { tone: StatusTone; label: string; detail: string } {
  const counts = new Map<StatusTone, number>();
  cards.forEach((card) => counts.set(card.tone, (counts.get(card.tone) ?? 0) + 1));
  const priority: StatusTone[] = ["fail", "warn", "unknown", "ok", "idle"];
  const tone = priority.find((candidate) => counts.has(candidate)) ?? "unknown";
  const detail = priority.filter((candidate) => counts.has(candidate))
    .map((candidate) => `${counts.get(candidate)} 项${toneLabel(candidate)}`).join(" · ");
  return { tone, label: toneLabel(tone), detail: detail || "等待状态" };
}

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
      title: "USB CDC / ACM",
      tone: "fail",
      summary: "SSH 未就绪",
      failureReason: "无法探测 USB：SSH 未连接或失败",
      rows: [
        { label: "MCU CDC", value: "—", tone: "idle" },
        { label: "串口", value: "—" },
        { label: "VID:PID", value: "0483:5740", tone: "idle" },
      ],
      actions: [refreshAction],
    };
  }

  if (!usbChecked && !usbProbe) {
    return {
      id: "usb",
      title: "USB CDC / ACM",
      tone: "idle",
      summary: "检查中…",
      rows: [
        { label: "MCU CDC", value: "检查中…", tone: "idle" },
        { label: "串口", value: "—" },
        { label: "VID:PID", value: "0483:5740", tone: "idle" },
      ],
      actions: [refreshAction],
    };
  }

  if (usbProbe?.error) {
    return {
      id: "usb",
      title: "USB CDC / ACM",
      tone: "fail",
      summary: "探测失败",
      failureReason: usbProbe.error,
      rows: [
        { label: "MCU CDC", value: "探测失败", tone: "fail" },
        { label: "串口", value: "—" },
        { label: "VID:PID", value: "0483:5740", tone: "fail" },
      ],
      actions: [refreshAction],
    };
  }

  const mcuOk = Boolean(usbProbe?.mcuPresent);
  const tone: StatusTone = mcuOk ? "ok" : "fail";
  const serial = usbProbe?.serialPath?.trim() || "";
  const vidPid = usbProbe?.mcuVidPid || "0483:5740";
  return {
    id: "usb",
    title: "USB CDC / ACM",
    tone,
    summary: mcuOk ? `MCU 已识别 · ${vidPid}` : "MCU 未插",
    detail: mcuOk
      ? `STM32 Virtual ComPort ${vidPid}${serial ? ` · ${serial}` : ""}`
      : undefined,
    failureReason: mcuOk ? undefined : "未检测到 VID:PID 0483:5740（STM32 Virtual ComPort / ttyACM）",
    rows: [
      { label: "MCU CDC", value: mcuOk ? `已识别 · ${vidPid}` : "未插", tone: mcuOk ? "ok" : "fail" },
      { label: "串口", value: serial || (mcuOk ? "未知" : "—"), tone: serial ? "ok" : mcuOk ? "unknown" : "idle" },
      { label: "VID:PID", value: vidPid, tone: mcuOk ? "ok" : "fail" },
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
  controlStopped?: boolean;
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
    controlStopped = false,
  } = input;

  const sessionUp = stage === "connected" || sshOk;
  const tunnelPort = localPort ?? profile.localPort;
  const rosReady = isRosReady(jointState);
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
  const domainHint = domainMismatchHint(profile.rosDomainId, lastKnownDomainId, defaultProfile.rosDomainId);
  const bridgeRows: StatusRow[] = [
    { label: "WS", value: bridgeConnected ? "已连接" : "未连接", tone: bridgeConnected ? "ok" : "idle" },
  ];
  if (hello?.bridgeVersion) {
    bridgeRows.push({ label: "bridge_version", value: hello.bridgeVersion, tone: "ok" });
  }
  if (hello?.bridgeBuildId) {
    bridgeRows.push({ label: "bridge_build_id", value: hello.bridgeBuildId, tone: "ok" });
  }
  if (hello?.rosDistro) {
    bridgeRows.push({ label: "ros_distro", value: hello.rosDistro, tone: "ok" });
  }
  bridgeRows.push(
    { label: "监听期望", value: `127.0.0.1:${remotePort}` },
    { label: "DDS Domain", value: String(profile.rosDomainId), tone: domainHint ? "warn" : "ok" },
  );
  if (domainHint || lastKnownDomainId != null) {
    bridgeRows.push({
      label: "Domain 提示",
      value: domainHint || (lastKnownDomainId == null ? "与默认一致" : `上次成功 ${lastKnownDomainId}`),
      tone: domainHint ? "warn" : "ok",
    });
  }
  const bridgeCard: StatusCardModel = {
    id: "bridge",
    title: "Bridge",
    tone: bridgeConnected
      ? (domainHint ? "warn" : "ok")
      : stage === "failed" ? "fail" : "idle",
    summary: bridgeConnected ? "WebSocket 已连接" : "未连接",
    detail: bridgeConnected && hello?.bridgeVersion
      ? `版本 ${versionText} · ROS_DOMAIN_ID=${profile.rosDomainId}`
      : bridgeConnected
        ? `ROS_DOMAIN_ID=${profile.rosDomainId}`
        : undefined,
    failureReason: !bridgeConnected && stage === "failed" ? "Bridge WebSocket 未连接" : undefined,
    rows: bridgeRows,
    note: domainHint || (hello ? undefined : "hello 尚未收到；版本字段待 Bridge 回包。"),
  };

  const agent = formatAgentSummary(agentStatus, agentError, agentChecked);
  const agentOnline = isAgentOnline(agentStatus);
  const agentRows: StatusRow[] = [
    { label: "服务", value: "micro-ros-agent-stm32h723.service" },
    { label: "Active", value: agentStatus ? `${agentStatus.activeState}/${agentStatus.subState}` : agentError ? "检查失败" : "—", tone: agent.tone },
    { label: "PID", value: agentStatus?.mainPid ? String(agentStatus.mainPid) : "—" },
    { label: "开机 / systemd", value: agentStatus?.unitFileState || "—" },
  ];
  if (agentStatus?.description) {
    agentRows.push({ label: "systemd 描述", value: agentStatus.description, tone: "ok" });
  }
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
    rows: agentRows,
    note: agentError || "Agent 重启走 systemctl restart；不刷写固件。",
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
        label: "last_command_sequence",
        value: formatLastCommandSequence(hardwareStatus),
        tone: hardwareReceived && hardwareStatus?.last_command_sequence != null ? "ok" : "idle",
      },
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

  const actives = controlStopped ? [] : activeControllers(rosControl);
  const rosControlTone: StatusTone = controlStopped || !rosControl
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
    summary: controlStopped ? "控制环境已退出（预期）" : !rosControl
      ? "检查中…"
      : !rosControl.available
        ? "Controller Manager 离线"
        : actives.length > 0
          ? `${actives.length} 个 active`
          : "无 active Controller",
    detail: actives.length > 0 ? actives.join(", ") : undefined,
    failureReason: !controlStopped && rosControl && !rosControl.available ? rosControl.message || "Controller Manager 不可用" : undefined,
    rows: [
      { label: "Manager", value: rosControl?.manager ?? "/controller_manager" },
      { label: "可用", value: controlStopped ? "否（已按请求退出）" : rosControl ? (rosControl.available ? "是" : "否") : "—", tone: controlStopped ? "idle" : rosControl?.available ? "ok" : rosControl ? "fail" : "idle" },
      { label: "Active", value: actives.length > 0 ? actives.join(", ") : "—", tone: actives.length > 0 ? "ok" : "idle" },
      { label: "全部", value: rosControl?.available ? String(rosControl.controllers.length) : "—" },
    ],
    note: controlStopped ? "输出关闭、旧控制环境清理均已核验；Controller Manager 此时离线属预期。" : rosControl?.message || undefined,
  };

  const usbCard = buildUsbCard({ sshOk, usbProbe, usbChecked });

  const teleopScriptRunning = Boolean(armMode?.teleopRunning);
  const teleopControllerActive = isArmTeleopControllerActive(rosControl);
  const teleopActive = !controlStopped && (rosControl?.available ? teleopControllerActive : teleopScriptRunning);
  const teleopGravityWarn = gravityInactiveWarning(teleopActive, rosControl);
  const teleopCard: StatusCardModel = {
    id: "teleop",
    title: "Teleop",
    tone: !sshOk ? "idle" : teleopActive ? (teleopGravityWarn ? "warn" : "ok") : "idle",
    summary: !sshOk ? "SSH 未就绪" : teleopActive ? "运行中" : "未运行",
    detail: teleopActive
      ? (armMode?.teleopPid
        ? `PID ${armMode.teleopPid} · ${ARM_TELEOP_CONTROLLER}`
        : ARM_TELEOP_CONTROLLER)
      : undefined,
    rows: [
      { label: "状态", value: teleopActive ? "运行中" : "未运行", tone: teleopActive ? "ok" : "idle" },
      { label: "PID", value: armMode?.teleopPid ? String(armMode.teleopPid) : "—" },
      { label: "脚本", value: "scripts/start_arm_teleop.sh" },
      { label: "控制器", value: ARM_TELEOP_CONTROLLER, tone: teleopControllerActive ? "ok" : teleopActive ? "warn" : "idle" },
      gravityCompensationRow({ rosControl, modeActive: teleopActive }),
    ],
    note: armMode?.message || "由上方模式区启动；切换前安全回零、关闭输出并清理旧控制进程。",
    warning: teleopGravityWarn,
  };

  const trajScriptRunning = Boolean(armMode?.trajectoryRunning);
  const trajControllerActive = isArmTrajectoryControllerActive(rosControl);
  const trajActive = !controlStopped && (rosControl?.available ? trajControllerActive : trajScriptRunning);
  const trajGravityWarn = gravityInactiveWarning(trajActive, rosControl);
  const trajectoryCard: StatusCardModel = {
    id: "trajectory",
    title: "Trajectory / MoveIt",
    tone: !sshOk ? "idle" : trajActive ? (trajGravityWarn ? "warn" : "ok") : "idle",
    summary: !sshOk ? "SSH 未就绪" : trajActive ? "运行中" : "未运行",
    detail: trajActive
      ? `PID ${armMode?.trajectoryPid || "—"} · ${ARM_TRAJECTORY_CONTROLLER}`
      : undefined,
    rows: [
      { label: "状态", value: trajActive ? "运行中" : "未运行", tone: trajActive ? "ok" : "idle" },
      { label: "PID", value: armMode?.trajectoryPid ? String(armMode.trajectoryPid) : "—" },
      { label: "启动", value: "Trajectory 一键启动：JTC + gravity + MoveIt" },
      { label: "控制器", value: ARM_TRAJECTORY_CONTROLLER, tone: trajControllerActive ? "ok" : trajActive ? "warn" : "idle" },
      { label: "互斥", value: "与 Teleop/VLA 互斥" },
      gravityCompensationRow({ rosControl, modeActive: trajActive }),
    ],
    note: "由上方模式区启动；清理旧控制环境后重新初始化，默认启用独立重力补偿。",
    warning: trajGravityWarn,
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
  const vlaHz = vlaChunkSample?.hz;
  const vlaChunkOk = Boolean(vlaHz && vlaHz > 0);
  const fwTrack = isHardwareTrack(hardwareStatus);
  const fwHold = isHardwareHold(hardwareStatus);
  let vlaTone: StatusTone = "idle";
  let vlaSummary = "未知";
  let vlaDetail: string | undefined;
  let vlaFailure: string | undefined;
  let vlaWarning: string | undefined = VLA_ONE_CLICK_RISK_WARNING;
  if (controlStopped) {
    vlaTone = "idle";
    vlaSummary = "未运行";
    vlaWarning = undefined;
  } else if (!sshOk) {
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
    if (fwTrack) {
      vlaTone = "ok";
      vlaSummary = vlaChunkOk ? `TRACK · ${formatHz(vlaHz)}` : "TRACK · 控制器 active";
      vlaDetail = vlaChunkOk
        ? `${VLA_POSITION_CONTROLLER} · TRACK · ${VLA_CHUNK_TOPIC} ${formatHz(vlaHz)}`
        : `${VLA_POSITION_CONTROLLER} active · 固件 TRACK`;
      vlaWarning = undefined;
    } else if (fwHold || hardwareStatus) {
      vlaTone = "warn";
      vlaSummary = "控制器 active · 固件未 TRACK";
      vlaDetail = `固件 ${formatHardwareMode(hardwareStatus)}（期望 TRACK；HOLD/safe_stop 闩锁未解除）`;
      vlaWarning = "VLA 控制器已切换，但固件仍非 TRACK；请确认未卡在 safe_stop/HOLD。";
    } else {
      vlaTone = "ok";
      vlaSummary = vlaChunkOk ? `运行中 · ${formatHz(vlaHz)}` : "控制器 active";
      vlaDetail = vlaChunkOk
        ? `${VLA_POSITION_CONTROLLER} · ${VLA_CHUNK_TOPIC} ${formatHz(vlaHz)}`
        : `${VLA_POSITION_CONTROLLER} active · 等待 ${VLA_CHUNK_TOPIC}`;
    }
  } else {
    vlaTone = "idle";
    vlaSummary = "未运行";
  }
  const vlaGravityWarn = gravityInactiveWarning(vlaActive, rosControl);
  if (vlaActive && vlaGravityWarn && vlaTone === "ok") {
    vlaTone = "warn";
  }
  let mergedVlaWarning = vlaWarning;
  if (vlaActive && vlaGravityWarn) {
    if (!mergedVlaWarning || mergedVlaWarning === VLA_ONE_CLICK_RISK_WARNING) {
      mergedVlaWarning = vlaGravityWarn;
    } else if (!mergedVlaWarning.includes(GRAVITY_COMPENSATION_CONTROLLER)) {
      mergedVlaWarning = `${mergedVlaWarning}；${vlaGravityWarn}`;
    }
  }
  const vlaRows: StatusRow[] = [
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
    gravityCompensationRow({ rosControl, modeActive: vlaActive }),
  ];
  if (vlaActive) {
    vlaRows.push({
      label: "固件闩锁",
      value: fwTrack ? "TRACK" : fwHold ? "HOLD / safe_stop" : formatHardwareMode(hardwareStatus),
      tone: fwTrack ? "ok" : "warn",
    });
  }
  const vlaCard: StatusCardModel = {
    id: "vla",
    title: "VLA",
    tone: vlaTone,
    summary: vlaSummary,
    detail: vlaDetail,
    failureReason: vlaFailure,
    rows: vlaRows,
    note: `Scheme B：外部推理 → ${VLA_CHUNK_TOPIC} → ${VLA_POSITION_CONTROLLER}；并行 ${GRAVITY_COMPENSATION_CONTROLLER}。由上方模式条启停。`,
    warning: mergedVlaWarning,
  };

  return [
    sshCard,
    bridgeCard,
    agentCard,
    hardwareCard,
    rosReadyCard,
    rosControlCard,
    usbCard,
    teleopCard,
    trajectoryCard,
    vlaCard,
    realsenseCard,
  ];
}

export type StatusQuickAction = {
  id: "teleop" | "trajectory" | "vla" | "stop" | "disable-stop";
  label: string;
  disabled?: boolean;
  disabledReason?: string;
};

export function buildStatusQuickActions(input: {
  sshOk: boolean;
  rosReady: boolean;
  actionBusy?: string | null;
  vlaActive?: boolean;
  hardwareStatus?: { fault_code?: number } | null;
}): StatusQuickAction[] {
  const fault11Reason = fault11StartBlockReason(input.hardwareStatus);
  const gateOk = input.sshOk && input.rosReady && !fault11Reason;
  const reason = !input.sshOk
    ? "SSH 未就绪"
    : !input.rosReady
      ? "等待 JointState"
      : fault11Reason;
  const busy = input.actionBusy;
  const modeBusy = busy === "teleop-restart" || busy === "trajectory-restart" || busy === "vla-start" || busy === "vla-stop" || busy === "arm-stop";
  return [
    {
      id: "teleop",
      label: "Teleop",
      disabled: !gateOk || modeBusy,
      disabledReason: reason || (modeBusy ? "操作进行中" : undefined),
    },
    {
      id: "trajectory",
      label: "Trajectory",
      disabled: !gateOk || modeBusy,
      disabledReason: reason || (modeBusy ? "操作进行中" : undefined),
    },
    {
      id: "vla",
      label: "VLA",
      disabled: !gateOk || modeBusy,
      disabledReason: reason || (modeBusy ? "操作进行中" : undefined),
    },
    {
      id: "stop",
      label: busy === "arm-stop" || busy === "vla-stop" ? "停止中…" : "停止",
      disabled: !input.sshOk || modeBusy,
      disabledReason: !input.sshOk ? "SSH 未就绪" : busy === "arm-stop" || busy === "vla-stop" ? "操作进行中" : undefined,
    },
    {
      id: "disable-stop",
      label: "解除输出",
      disabled: !input.sshOk || modeBusy,
      disabledReason: !input.sshOk ? "SSH 未就绪" : modeBusy ? "操作进行中" : "需要现场支撑机械臂，DISABLE 后电机不再输出",
    },
  ];
}
