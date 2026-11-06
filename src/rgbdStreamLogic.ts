import { useEffect, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope, ConnectionProfile } from "./types";
import {
  applyRgbdFrameToSession, createRgbdSessionState, parseRgbdFrameMeta,
  resetRgbdSession, type RgbdSessionState, type RgbdFrameMeta,
} from "./rgbdPointCloudLogic";

export const RGBD_FRAME_TTL_MS = 500;
export function expireRgbdSession(state: RgbdSessionState, nowMs: number): RgbdSessionState {
  if (!state.cloud || nowMs < (state.expiresAt ?? state.lastFrameAt + RGBD_FRAME_TTL_MS)) return state;
  return { ...state, cloud: null, stale: true, tfOk: false, tfError: "超过 500 ms 未收到有效 RGBD 帧，等待新帧" };
}

/** Each effect owns one subscription lease, one complete pending frame and one
 * receive-time expiry. Cancellation cannot apply an old RAF update to a new lease. */
export function useRgbdStream(
  bridge: Pick<BridgeClient, "send" | "onMessage">,
  active: boolean,
  connected: boolean,
  profile: ConnectionProfile,
  strictToken: boolean,
  connectionKey: string,
  detectObjects = false,
) {
  const [state, setState] = useState(() => createRgbdSessionState());
  const key = JSON.stringify([connectionKey, profile.rgbdRgbTopic, profile.rgbdDepthTopic,
    profile.rgbdCameraInfoTopic, profile.rgbdTargetFrame, profile.rgbdMaxWidth,
    profile.rgbdMaxHeight, profile.rgbdMaxFps, detectObjects]);
  useEffect(() => {
    setState(resetRgbdSession);
    if (!active || !connected) return;
    const token = crypto.randomUUID();
    setState(current=>({...current,subscriptionId:token}));
    let valid = true, raf: number | null = null, expiry: number | undefined;
    let pending: { meta: RgbdFrameMeta; payload: Uint8Array; at: number; expiresAt: number } | null = null;
    const clearPending = () => {
      pending = null;
      if (raf !== null) window.cancelAnimationFrame(raf);
      raf = null;
    };
    const fail = (message: string) => {
      clearPending();
      setState((current) => valid ? { ...current, cloud: null, stale: true, tfOk: false, tfError: message } : current);
    };
    const stop = bridge.onMessage((message: BridgeEnvelope) => {
      if (!valid) return;
      if (message.op === "error" && message.request_id === token) { fail(String(message.message || message.error || "RGBD 订阅失败")); return; }
      if (message.op !== "rgbd_frame") return;
      if ((strictToken && message.subscription_id !== token) ||
          (message.subscription_id !== undefined && message.subscription_id !== token)) return;
      // Legacy Bridge frames have no token. Respect interest and reject different
      // configurations, while documenting that same-config late packets lack a strong lease ID.
      for (const [field, expected] of [["rgb_topic", profile.rgbdRgbTopic], ["depth_topic", profile.rgbdDepthTopic],
        ["camera_info_topic", profile.rgbdCameraInfoTopic], ["target_frame", profile.rgbdTargetFrame]] as const) {
        if (message[field] !== undefined && message[field] !== expected) return;
      }
      try {
        const meta = parseRgbdFrameMeta(message);
        if (detectObjects && meta.objects === undefined) meta.objects = null;
        if (!meta.tf_ok) { fail(meta.error || meta.tf_error || "TF 查询失败"); return; }
        const at = performance.now();
        const remaining = RGBD_FRAME_TTL_MS - (meta.frame_age_ms ?? 0);
        pending = { meta, payload: message.rgbd_payload ?? new Uint8Array(), at, expiresAt: at + remaining };
        if (expiry !== undefined) window.clearTimeout(expiry);
        expiry = window.setTimeout(() => {
          if (valid) setState((current) => expireRgbdSession(current, performance.now()));
        }, remaining);
        if (raf !== null) return;
        raf = window.requestAnimationFrame(() => {
          raf = null;
          const frame = pending;
          pending = null;
          if (!valid || !frame) return;
          setState((current) => {
            if (!valid) return current;
            const next = { ...applyRgbdFrameToSession(current, current.sessionId, frame.meta, frame.payload, frame.at), expiresAt: frame.expiresAt };
            return expireRgbdSession(next, performance.now());
          });
        });
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
    bridge.send({ op: "subscribe_rgbd", subscription_id: token, request_id: token,
      ...(detectObjects ? { detect_objects: true } : {}),
      rgb_topic: profile.rgbdRgbTopic, depth_topic: profile.rgbdDepthTopic,
      camera_info_topic: profile.rgbdCameraInfoTopic, target_frame: profile.rgbdTargetFrame,
      max_width: profile.rgbdMaxWidth, max_height: profile.rgbdMaxHeight, max_fps: profile.rgbdMaxFps });
    return () => {
      valid = false;
      stop();
      clearPending();
      if (expiry !== undefined) window.clearTimeout(expiry);
      bridge.send({ op: "unsubscribe_rgbd" });
    };
  }, [bridge, active, connected, key, strictToken]);
  return [state, setState] as const;
}
