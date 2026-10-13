import type { ConnectionProfile } from "./types";
import { defaultProfile } from "./types";

export type CollapsiblePanel = "topics" | "rosControl" | "inspector";
export type PanelState = Record<CollapsiblePanel, boolean>;
export type TopicSample = { data: unknown; count: number; firstAt: number; lastAt: number; hz: number };

export const defaultPanelState: PanelState = { topics: true, rosControl: true, inspector: true };

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
