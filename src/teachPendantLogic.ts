import { captureCurrentArmPose, parsePositionStore, type CustomPosition } from "./positionLogic";

export type RelaySample = {
  topic: string;
  state: { name?: string[]; position?: number[] } | null;
  receivedAt: number | null;
};

export function positionsFromApi(raw: unknown): CustomPosition[] {
  const positions = Array.isArray(raw) ? raw : [];
  return parsePositionStore(JSON.stringify({ schemaVersion: 2, profiles: { api: { positions } } }), "").profiles.api?.positions ?? [];
}

export type RelayFeedback = {
  bridgeConnected: boolean;
  profileKey: string;
  positions: number[] | null;
  gripperPosition: number | null;
  error: string;
};

export function isTeachPath(pathname: string) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/teach" || path.endsWith("/teach");
}

export function teachToken(search: string) {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("token")?.trim() ?? "";
}

export function teachLiveUrl(pageUrl: string) {
  const url = new URL(pageUrl);
  const token = url.searchParams.get("token")?.trim() ?? "";
  const socket = new URL("/api/teach/live", url);
  socket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) socket.searchParams.set("token", token);
  return socket.toString();
}

/** Snapshot the desktop would save, using the Bridge session the desk already owns. */
export function relayFeedback(input: {
  bridgeConnected: boolean;
  profileKey: string;
  samples: RelaySample[];
  now: number;
  preferredTopic: string;
  gripperPosition?: number;
}): RelayFeedback {
  if (!input.bridgeConnected) {
    return {
      bridgeConnected: false,
      profileKey: input.profileKey,
      positions: null,
      gripperPosition: null,
      error: "桌面端尚未连接 Jetson Bridge",
    };
  }
  const captured = captureCurrentArmPose(input.samples, input.now, input.preferredTopic);
  if ("error" in captured) {
    return {
      bridgeConnected: true,
      profileKey: input.profileKey,
      positions: null,
      gripperPosition: input.gripperPosition ?? null,
      error: captured.error,
    };
  }
  return {
    bridgeConnected: true,
    profileKey: input.profileKey,
    positions: captured.positions,
    gripperPosition: input.gripperPosition ?? null,
    error: "",
  };
}
