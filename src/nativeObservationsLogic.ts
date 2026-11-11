import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeEnvelope } from "./types";

export type ObservationSource = "agent" | "usb" | "arm" | "controllers" | "topics" | "clock";
export type NativeObservation = {
  sequence: number;
  value: unknown;
  error: string | null;
  age_ms: number;
  ttl_ms: number;
  receivedAt: number;
  expired: boolean;
};
type WireObservation = Omit<NativeObservation, "receivedAt" | "expired">;
export type ObservationSnapshot = { epoch: number; revision: number; connected: boolean; handler_elapsed_ms?: number; entries: Partial<Record<ObservationSource, WireObservation>> };
type View = Omit<ObservationSnapshot, "entries"> & { entries: Partial<Record<ObservationSource, NativeObservation>> };
const empty = (): View => ({ epoch: -1, revision: -1, connected: false, entries: {} });
export const observationAge = (entry: NativeObservation, now = performance.now()) => entry.age_ms + Math.max(0, now - entry.receivedAt);
export function observationValue<T>(entry?: NativeObservation): T {
  if (!entry) throw new Error("等待共享状态查询");
  if (entry.error) throw new Error(entry.error);
  if (entry.expired || observationAge(entry) >= entry.ttl_ms) throw new Error("共享状态已过期，等待更新");
  return entry.value as T;
}
/** Retain the source age across native caching and IPC, never renew on repaint. */
export function observationEnvelope(entry: NativeObservation): BridgeEnvelope {
  const value = observationValue<BridgeEnvelope>(entry);
  const age = observationAge(entry);
  const controllerAge = typeof value.snapshot_age_ms === "number" ? value.snapshot_age_ms + age : undefined;
  return { ...value, desktop_received_at_ms: performance.now() - age,
    ...(value.op === "controllers_info" ? { snapshot_age_ms: controllerAge, request_wait_ms: 0,
      ...(value.fresh && controllerAge !== undefined && controllerAge >= entry.ttl_ms ? { fresh: false, available: false, query_state: "stale" as const, message: "Controller 快照已过期；保留上次列表供只读查看" } : {}) } : {}),
  };
}
export type SharedObservations = ReturnType<typeof useNativeObservations>;

/** Event-driven native snapshots: zero per-WebView remote polling timers. */
export function useNativeObservations(enabled: boolean, sessionKey: string) {
  const [view, setView] = useState<View>(empty);
  const current = useRef<View>(empty());
  const generation = useRef(0);
  const accept = useCallback((snapshot: ObservationSnapshot, started: number) => {
    if (snapshot.revision < current.current.revision || snapshot.epoch < current.current.epoch) return;
    const now = performance.now();
    const entries: View["entries"] = {};
    for (const [key, entry] of Object.entries(snapshot.entries)) {
      const age = entry.age_ms + Math.max(0, now - started - (snapshot.handler_elapsed_ms ?? 0));
      entries[key as ObservationSource] = { ...entry, age_ms: age, receivedAt: now, expired: age >= entry.ttl_ms };
    }
    current.current = { ...snapshot, entries: snapshot.connected ? entries : {} };
    setView(current.current);
  }, []);
  useEffect(() => {
    const at = ++generation.current;
    current.current = empty(); setView(current.current);
    if (!enabled) return;
    let disposed = false, reading = false, pending = false, eventRevision = 0;
    let stop: (() => void) | undefined;
    const read = async () => {
      pending = true; eventRevision++;
      if (reading) return;
      reading = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const expected = eventRevision, started = performance.now();
          const snapshot = await invoke<ObservationSnapshot>("native_observation_snapshot");
          if (!disposed && expected === eventRevision) accept(snapshot, started);
        }
      } catch { /* Expiry still fails closed when IPC becomes unavailable. */ }
      finally { reading = false; if (pending && !disposed) void read(); }
    };
    void listen("native-observations-changed", () => void read()).then(unlisten => {
      if (disposed) unlisten(); else { stop = unlisten; void read(); }
    }).catch(() => { if (!disposed) void read(); });
    const expiry = window.setInterval(() => {
      const entries = { ...current.current.entries };
      let changed = false;
      for (const [source, entry] of Object.entries(entries)) {
        if (!entry.expired && observationAge(entry) >= entry.ttl_ms) {
          entries[source as ObservationSource] = { ...entry, expired: true }; changed = true;
        }
      }
      if (changed) { current.current = { ...current.current, entries }; setView(current.current); }
    }, 250);
    return () => { disposed = true; if (generation.current === at) generation.current++; stop?.(); window.clearInterval(expiry); };
  }, [enabled, sessionKey, accept]);
  const refresh = useCallback(async (source: ObservationSource, afterPending = false) => {
    const at = generation.current, epoch = current.current.epoch;
    if (!enabled || !current.current.connected) throw new Error("请先连接机器人");
    const started = performance.now();
    const snapshot = await invoke<ObservationSnapshot>("native_observation_refresh", { source, epoch, afterPending });
    if (at !== generation.current || current.current.epoch !== epoch || snapshot.epoch !== epoch || !snapshot.connected) throw new Error("共享查询会话已改变");
    accept(snapshot, started);
    // Return the newest accepted value, not a superseded manual response.
    const entry = current.current.entries[source];
    if (!entry) throw new Error("共享查询未返回结果");
    observationValue(entry);
    return entry;
  }, [enabled, accept]);
  return { enabled, ...view, refresh };
}
