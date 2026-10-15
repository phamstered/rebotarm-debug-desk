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
