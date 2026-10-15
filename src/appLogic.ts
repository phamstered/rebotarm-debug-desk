import type { BridgeHello } from "./bridge";
import { EXPECTED_BRIDGE_BUILD_ID, EXPECTED_BRIDGE_VERSION } from "./bridgeVersion";
import type { ConnectionProfile } from "./types";
import { defaultProfile } from "./types";

export type CollapsiblePanel = "topics" | "rosControl" | "inspector";
export type PanelState = Record<CollapsiblePanel, boolean>;
export type TopicSample = { data: unknown; count: number; firstAt: number; lastAt: number; hz: number };

export const defaultPanelState: PanelState = { topics: true, rosControl: true, inspector: true };
export type SidebarState = { left: boolean; right: boolean };
export const defaultSidebarState: SidebarState = { left: true, right: true };

export function loadSidebarState(storage: Pick<Storage, "getItem"> = localStorage): SidebarState {
  try {
    const parsed = JSON.parse(storage.getItem("easy-debug-sidebars") ?? "null") as Partial<SidebarState> | null;
    return { left: typeof parsed?.left === "boolean" ? parsed.left : true, right: typeof parsed?.right === "boolean" ? parsed.right : true };
  } catch {
    return { ...defaultSidebarState };
  }
}

export function migrateProfile(saved: Partial<ConnectionProfile>): ConnectionProfile {
  const profile = { ...defaultProfile, ...saved } as ConnectionProfile;
  // Legacy migration: exact-match a setup path that early builds saved to
  // localStorage, so old configs move to the current default. This literal only
  // matches stored data; it is never used as a default.
  if (profile.rosSetupScript === "/home/jialiang/Project/install/setup.bash") {
    profile.rosSetupScript = defaultProfile.rosSetupScript;
  }
  if (profile.jointStateTopic === "/joint_states") {
    profile.jointStateTopic = defaultProfile.jointStateTopic;
  }
  return profile;
}

export function loadProfile(storage: Pick<Storage, "getItem"> = localStorage): ConnectionProfile {
  const saved = storage.getItem("easy-debug-profile");
  if (!saved) return defaultProfile;
  try {
    return migrateProfile(JSON.parse(saved) as Partial<ConnectionProfile>);
  } catch {
    return defaultProfile;
  }
}

export function loadPanelState(storage: Pick<Storage, "getItem"> = localStorage): PanelState {
  try {
    const saved = storage.getItem("easy-debug-panels");
    if (!saved) return defaultPanelState;
    const parsed = JSON.parse(saved) as Partial<PanelState>;
    return {
      topics: parsed.topics ?? defaultPanelState.topics,
      rosControl: parsed.rosControl ?? defaultPanelState.rosControl,
      inspector: parsed.inspector ?? defaultPanelState.inspector,
    };
  } catch {
    return defaultPanelState;
  }
}

export function nextTopicSample(previous: TopicSample | undefined, data: unknown, now: number): TopicSample {
  const count = (previous?.count ?? 0) + 1;
  const firstAt = previous?.firstAt ?? now;
  const elapsed = Math.max((now - firstAt) / 1000, 0.001);
  return { data, count, firstAt, lastAt: now, hz: count > 1 ? (count - 1) / elapsed : 0 };
}

export type BridgeVersionSnapshot = {
  version: string;
  buildId: string;
};

export type BridgeVersionCheck =
  | { status: "match"; local: BridgeVersionSnapshot; remote: BridgeVersionSnapshot }
  | {
      status: "mismatch";
      local: BridgeVersionSnapshot;
      remote: BridgeVersionSnapshot;
    }
  | {
      status: "unknown";
      reason: "missing_build_id";
      local: BridgeVersionSnapshot;
      remote: BridgeVersionSnapshot;
      message: string;
    };

export function expectedBridgeVersion(): BridgeVersionSnapshot {
  return { version: EXPECTED_BRIDGE_VERSION, buildId: EXPECTED_BRIDGE_BUILD_ID };
}

export function formatBridgeVersionLabel(snapshot: BridgeVersionSnapshot): string {
  const version = snapshot.version.trim() || "未知";
  const buildId = snapshot.buildId.trim();
  return buildId ? `${version} (${buildId})` : `${version}（无 build id）`;
}

/** Compare remote hello against the desk-shipped expected Bridge identity. */
export function checkBridgeVersion(
  hello: BridgeHello | null | undefined,
  expected: BridgeVersionSnapshot = expectedBridgeVersion(),
): BridgeVersionCheck {
  const remote: BridgeVersionSnapshot = {
    version: (hello?.bridge_version ?? "").trim(),
    buildId: (hello?.bridge_build_id ?? "").trim(),
  };
  const local: BridgeVersionSnapshot = {
    version: expected.version.trim(),
    buildId: expected.buildId.trim(),
  };

  if (!remote.buildId) {
    return {
      status: "unknown",
      reason: "missing_build_id",
      local,
      remote,
      message: "无法确认版本",
    };
  }

  if (remote.buildId === local.buildId && remote.version === local.version) {
    return { status: "match", local, remote };
  }

  return { status: "mismatch", local, remote };
}


export type ConnectStage = "idle" | "ssh" | "tunnel" | "bridge" | "upgrading" | "connected" | "failed";
export type ConnectStepId = "ssh" | "session" | "bridge" | "agent";
export type LightState = "idle" | "pending" | "ok" | "fail" | "warn";

export type ConnectStep = { id: ConnectStepId; label: string };

export const CONNECT_STEPS: ConnectStep[] = [
  { id: "ssh", label: "检查 SSH" },
  { id: "session", label: "建立会话" },
  { id: "bridge", label: "连接 Bridge" },
  { id: "agent", label: "确认 Agent" },
];

export type ConnectStatusLights = {
  ssh: LightState;
  bridge: LightState;
  agent: LightState;
  hardware: LightState;
};

export type RecentHost = {
  host: string;
  username: string;
  sshPort: number;
  identityFile: string;
  lastUsedAt: number;
};

export const RECENT_HOSTS_KEY = "easy-debug-recent-hosts";
export const LAST_KNOWN_DOMAIN_KEY = "easy-debug-last-ros-domain-id";
export const MAX_RECENT_HOSTS = 6;

export function isAgentOnline(agent: { activeState?: string; subState?: string } | null | undefined): boolean {
  return agent?.activeState === "active" && agent?.subState === "running";
}

export function isRosReady(jointState: unknown): boolean {
  return Boolean(jointState && typeof jointState === "object");
}

export function stageToConnectStep(stage: ConnectStage): ConnectStepId | null {
  switch (stage) {
    case "ssh":
      return "ssh";
    case "tunnel":
      return "session";
    case "bridge":
    case "upgrading":
      return "bridge";
    case "connected":
      return "agent";
    default:
      return null;
  }
}

export function connectStepStatus(
  stepId: ConnectStepId,
  stage: ConnectStage,
  failedStep: ConnectStepId | null,
  agentChecked: boolean,
): "pending" | "current" | "done" | "failed" | "idle" {
  if (stage === "idle") return "idle";
  if (stage === "failed" && failedStep === stepId) return "failed";
  const order: ConnectStepId[] = ["ssh", "session", "bridge", "agent"];
  const current = stage === "failed" ? failedStep : stageToConnectStep(stage);
  if (!current) return stage === "failed" ? "idle" : "idle";
  const stepIndex = order.indexOf(stepId);
  const currentIndex = order.indexOf(current);
  if (stage === "failed") {
    if (stepIndex < currentIndex) return "done";
    if (stepIndex === currentIndex) return "failed";
    return "idle";
  }
  if (stage === "connected") {
    if (stepId === "agent") return agentChecked ? "done" : "current";
    return "done";
  }
  if (stepIndex < currentIndex) return "done";
  if (stepIndex === currentIndex) return "current";
  return "pending";
}

export function deriveConnectStatusLights(input: {
  stage: ConnectStage;
  failedStep: ConnectStepId | null;
  sshOk: boolean;
  bridgeUp: boolean;
  agentOnline: boolean;
  agentChecked: boolean;
  agentError: string;
  hardwareReceived: boolean;
}): ConnectStatusLights {
  const { stage, failedStep, sshOk, bridgeUp, agentOnline, agentChecked, agentError, hardwareReceived } = input;
  const light = (
    ok: boolean,
    pendingWhen: boolean,
    failWhen: boolean,
  ): LightState => {
    if (ok) return "ok";
    if (failWhen) return "fail";
    if (pendingWhen) return "pending";
    return "idle";
  };
  const connecting = stage === "ssh" || stage === "tunnel" || stage === "bridge" || stage === "connected";
  return {
    ssh: light(sshOk, stage === "ssh", stage === "failed" && failedStep === "ssh"),
    bridge: light(bridgeUp, stage === "bridge" || (stage === "tunnel" && sshOk), stage === "failed" && (failedStep === "bridge" || failedStep === "session")),
    agent: agentOnline
      ? "ok"
      : agentError && agentChecked
        ? "fail"
        : agentChecked && !agentOnline
          ? "warn"
          : light(false, connecting && (stage === "connected" || bridgeUp), stage === "failed" && failedStep === "agent"),
    hardware: light(hardwareReceived, bridgeUp && !hardwareReceived && stage === "connected", false),
  };
}

export function formatConnectError(raw: string, failedStep: ConnectStepId | null): string {
  const text = raw.trim() || "未知错误";
  const stepLabel = CONNECT_STEPS.find((step) => step.id === failedStep)?.label;
  const prefix = stepLabel ? `${stepLabel} 失败：` : "连接失败：";
  if (/permission denied|auth|publickey|password/i.test(text)) {
    return `${prefix}SSH 认证失败。请检查用户名、私钥或 ssh-agent。\n${text}`;
  }
  if (/timed? ?out|connection refused|no route|could not resolve|Name or service not known|Network is unreachable/i.test(text)) {
    return `${prefix}无法到达主机。请检查主机名、端口与网络。\n${text}`;
  }
  if (/port.*in use|Address already in use|bind/i.test(text)) {
    return `${prefix}本地端口不可用。可稍后重试，系统会自动选择空闲端口。\n${text}`;
  }
  if (/websocket|bridge|1006|ECONNRESET/i.test(text)) {
    return `${prefix}Bridge WebSocket 未就绪。请确认 Jetson 上 Bridge 已监听 127.0.0.1。\n${text}`;
  }
  return `${prefix}${text}`;
}

export function loadRecentHosts(storage: Pick<Storage, "getItem"> = localStorage): RecentHost[] {
  try {
    const raw = storage.getItem(RECENT_HOSTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentHost => {
        if (!item || typeof item !== "object") return false;
        const host = item as Partial<RecentHost>;
        return typeof host.host === "string" && host.host.trim().length > 0
          && typeof host.sshPort === "number"
          && typeof host.username === "string"
          && typeof host.identityFile === "string"
          && typeof host.lastUsedAt === "number";
      })
      .slice(0, MAX_RECENT_HOSTS);
  } catch {
    return [];
  }
}

export function rememberSuccessfulHost(
  profile: Pick<ConnectionProfile, "host" | "username" | "sshPort" | "identityFile">,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  now = Date.now(),
): RecentHost[] {
  const host = profile.host.trim();
  if (!host) return loadRecentHosts(storage);
  const next: RecentHost = {
    host,
    username: profile.username,
    sshPort: profile.sshPort,
    identityFile: profile.identityFile,
    lastUsedAt: now,
  };
  const previous = loadRecentHosts(storage).filter(
    (item) => !(item.host === next.host && item.username === next.username && item.sshPort === next.sshPort),
  );
  const hosts = [next, ...previous].slice(0, MAX_RECENT_HOSTS);
  storage.setItem(RECENT_HOSTS_KEY, JSON.stringify(hosts));
  return hosts;
}

export function loadLastKnownDomainId(storage: Pick<Storage, "getItem"> = localStorage): number | null {
  try {
    const raw = storage.getItem(LAST_KNOWN_DOMAIN_KEY);
    if (raw == null || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberLastKnownDomainId(
  rosDomainId: number,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(LAST_KNOWN_DOMAIN_KEY, String(rosDomainId));
}

export function domainMismatchHint(
  rosDomainId: number,
  lastKnownDomainId: number | null = null,
  defaultDomainId = defaultProfile.rosDomainId,
): string {
  if (rosDomainId !== defaultDomainId) {
    return `ROS_DOMAIN_ID=${rosDomainId}（默认 ${defaultDomainId}）；多机不一致时 Topic 会不可见`;
  }
  if (lastKnownDomainId != null && rosDomainId !== lastKnownDomainId) {
    return `ROS_DOMAIN_ID=${rosDomainId}，上次成功为 ${lastKnownDomainId}；请确认与机器人侧一致`;
  }
  return "";
}

export function applyRecentHostToProfile(profile: ConnectionProfile, host: RecentHost): ConnectionProfile {
  return {
    ...profile,
    host: host.host,
    username: host.username,
    sshPort: host.sshPort,
    identityFile: host.identityFile,
  };
}
