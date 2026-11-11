import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { ClockSyncInfo } from "./types";
import { observationAge, observationValue, type SharedObservations } from "./nativeObservationsLogic";

export type ClockSyncStatus = Omit<ClockSyncInfo, "state"> & {
  state: ClockSyncInfo["state"] | "unsupported" | "disconnected";
};
const waiting = (): ClockSyncStatus => ({ supported: true, state: "waiting", message: "等待 Jetson 时钟同步状态", source_topic: "", generation: 0 });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function parseClockSyncInfo(value: unknown): ClockSyncStatus {
  if (!object(value) || value.op !== "clock_sync_info") throw new Error("时钟同步响应无效");
  if (value.supported === false) return { ...waiting(), supported: false, state: "unsupported", message: "当前 Bridge 不支持时钟诊断，请更新 Bridge" };
  if (value.supported !== true || !["waiting", "synchronized", "unsynchronized", "stale"].includes(String(value.state)) || typeof value.message !== "string" || typeof value.source_topic !== "string" || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0)
    throw new Error("时钟同步响应字段无效");
  for (const key of ["source_offset_ms", "feedback_age_ms"]) {
    const v = value[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || (key === "feedback_age_ms" && v < 0))) throw new Error("时钟同步诊断数值无效");
  }
  if (value.state === "synchronized" && (value.source_offset_ms === undefined || value.feedback_age_ms === undefined)) throw new Error("时钟同步响应缺少偏差或帧龄");
  if (value.firmware !== undefined) {
    if (!object(value.firmware) || typeof value.firmware.supported !== "boolean" || (value.firmware.synchronized !== undefined && typeof value.firmware.synchronized !== "boolean")) throw new Error("固件时钟诊断无效");
    for (const key of ["sync_age_ms", "failure_count", "last_sync_duration_ms"]) {
      const v = value.firmware[key];
      if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new Error("固件时钟诊断数值无效");
    }
  }
  return { supported: true, state: value.state as ClockSyncInfo["state"], message: value.message, source_topic: value.source_topic, generation: Number(value.generation), source_offset_ms: value.source_offset_ms as number | undefined, feedback_age_ms: value.feedback_age_ms as number | undefined, firmware: value.firmware as ClockSyncInfo["firmware"] };
}

export function useClockSync(bridge: Pick<BridgeClient, "request">, connected: boolean, sessionKey: string, shared?: SharedObservations): ClockSyncStatus {
  const context = useMemo(() => ({ valid: connected }), [bridge, connected, sessionKey]);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; value: ClockSyncStatus } | null>(null);
  useEffect(() => {
    context.valid = connected;
    if (!connected || shared) return () => { context.valid = false; };
    const abort = new AbortController();
    let alive = true, pending = false, unsupported = false, receivedAt = -Infinity;
    const update = (value: ClockSyncStatus) => { if (alive && context.valid) setSnapshot({ context, value }); };
    const poll = async () => {
      if (pending || unsupported) return;
      pending = true;
      const started = performance.now();
      try {
        const reply = await bridge.request({ op: "clock_sync_info" }, 2000, abort.signal);
        if (!alive || !context.valid) return;
        if (performance.now() - started >= 2000) throw new Error("时钟同步响应已过期");
        const parsed = parseClockSyncInfo(reply);
        unsupported = parsed.state === "unsupported";
        receivedAt = performance.now();
        update(parsed);
      } catch (error) {
        if (!alive || !context.valid) return;
        const message = error instanceof Error ? error.message : String(error);
        unsupported = /未知操作|unknown (?:op|operation)|unsupported/i.test(message);
        update({ ...waiting(), supported: !unsupported, state: unsupported ? "unsupported" : "stale", message: unsupported ? "当前 Bridge 不支持时钟诊断，请更新 Bridge" : `时钟同步状态不可用：${message}` });
      } finally { pending = false; }
    };
    void poll();
    const polling = window.setInterval(() => { void poll(); }, 1000);
    const expiry = window.setInterval(() => {
      if (!unsupported && performance.now() - receivedAt >= 2500) setSnapshot((previous) => {
        if (!alive || !context.valid || previous?.context !== context || previous.value.state !== "synchronized") return previous;
        return { context, value: { ...previous.value, state: "stale", message: "时钟同步状态已过期，等待 Jetson 更新" } };
      });
    }, 250);
    return () => { alive = false; context.valid = false; abort.abort(); window.clearInterval(polling); window.clearInterval(expiry); };
  }, [context, bridge, connected, Boolean(shared)]);
  if (!connected) return { ...waiting(), state: "disconnected", message: "连接 Jetson 后检查时钟同步" };
  if (shared) {
    const entry = shared.entries.clock;
    try {
      const parsed = parseClockSyncInfo(observationValue(entry));
      return { ...parsed, feedback_age_ms: parsed.feedback_age_ms === undefined ? undefined : parsed.feedback_age_ms + observationAge(entry!) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unsupported = /未知操作|unknown (?:op|operation)|unsupported/i.test(message);
      return { ...waiting(), supported: !unsupported, state: unsupported ? "unsupported" : entry ? "stale" : "waiting", message };
    }
  }
  return snapshot?.context === context ? snapshot.value : waiting();
}
