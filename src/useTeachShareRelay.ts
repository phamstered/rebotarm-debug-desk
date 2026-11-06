import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relayFeedback, type RelaySample } from "./teachPendantLogic";

export function useTeachShareRelay(input: {
  bridgeConnected: boolean;
  profileKey: string;
  samples: RelaySample[];
  preferredTopic: string;
  gripperPosition?: number;
}) {
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const status = await invoke<{ url?: string } | null>("teach_share_status").catch(() => null);
      if (cancelled || !status?.url) return;
      const current = latest.current;
      const payload = relayFeedback({ ...current, now: performance.now() });
      await invoke("teach_share_publish_feedback", {
        bridgeConnected: payload.bridgeConnected,
        profileKey: payload.profileKey,
        positions: payload.positions,
        gripperPosition: payload.gripperPosition,
        error: payload.error,
      }).catch(() => undefined);
    };
    const timer = window.setInterval(() => { void tick(); }, 400);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
