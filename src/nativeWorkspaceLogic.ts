import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { AppPage } from "./appNavigationLogic";
import { APP_PAGES } from "./appNavigationLogic";
import type { BridgeClient, BridgeHello } from "./bridge";
import type { ConnectionProfile, TopicInfo } from "./types";

export const nativeDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export function hostedPageFromSearch(search: string): AppPage | undefined {
  const value = new URLSearchParams(search).get("page");
  return APP_PAGES.find(page => page === value);
}
export const PAGE_TITLES: Record<AppPage, string> = {
  status: "Status", dashboard: "Topics", motion: "Motion", monitor: "Monitor", collection: "数据采集",
  handeye: "手眼标定", motor: "Motor", calibration: "Joint4 标定", gravity: "重力辨识",
};
export type NativePageState = { detached: boolean; visible: boolean; ready: boolean; busy_reason: string; recovery_required?: boolean };
export type MotionNavigation = {revision:number;tab:"positions"|"groups";profile_key:string};
export type NativeWorkspaceSnapshot = { motion_navigation?: MotionNavigation | null; selected: AppPage; pages: Partial<Record<AppPage, NativePageState>> };
/** Reparented WKWebViews can report a stale document.hidden; native window state owns visibility. */
export function pageWindowVisible(documentVisible: boolean, page: AppPage | undefined, snapshot: NativeWorkspaceSnapshot) {
  return page ? snapshot.pages[page]?.visible === true : documentVisible;
}
export type NativeSessionContext = { epoch: number; connected: boolean; profile: ConnectionProfile | null; error: string | null };

/** Snapshots are authoritative; do not infer visibility from focus on a multi-monitor desktop. */
export function useNativeWorkspace(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<NativeWorkspaceSnapshot>({ selected: "status", pages: {} });
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let revision = 0;
    const unsubscribes: (() => void)[] = [];
    void (async () => {
      for (const [event, accept] of [
        ["workspace-state", (value: NativeWorkspaceSnapshot) => { revision++; setSnapshot(value); }],
        ["workspace-error", (value: string) => setError(value)],
      ] as const) {
        const unlisten = await listen(event, message => { if (!disposed) (accept as (value: unknown) => void)(message.payload); });
        if (disposed) unlisten(); else unsubscribes.push(unlisten);
      }
      const at = revision;
      const initial = await invoke<NativeWorkspaceSnapshot>("workspace_snapshot");
      if (!disposed && at === revision) setSnapshot(initial);
    })().catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; unsubscribes.forEach(unlisten => unlisten()); };
  }, [enabled]);
  async function action(command: "workspace_select" | "workspace_detach" | "workspace_dock" | "workspace_show_main" | "workspace_recover", page: AppPage) {
    setError("");
    try { await invoke(command, { page }); } catch (reason) { setError(String(reason)); }
  }
  return { snapshot, error, dismissError: () => setError(""), action };
}

/** Reattach only the page's consumer. The application-wide socket and SSH tunnel remain native-owned. */
export function useNativePageSession(options: {
  page?: AppPage;
  bridge: BridgeClient;
  reset(): void;
  profile(profile: ConnectionProfile): void;
  connected(profile: ConnectionProfile, hello: BridgeHello, topics: TopicInfo[]): void;
  disconnected(error: string): void;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  useEffect(() => {
    if (!options.page) return;
    let disposed = false;
    let epoch: number | undefined;
    let sequence = 0;
    let running = false;
    let pending = false;
    let unlisten: (() => void) | undefined;
    const { bridge } = options;
    const refresh = async () => {
      pending = true;
      sequence++;
      if (running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const current = sequence;
          const context = await invoke<NativeSessionContext>("native_bridge_context");
          if (disposed || current !== sequence) continue;
          if (context.connected && context.epoch === epoch) continue;
          epoch = undefined;
          bridge.close();
          callbacks.current.reset();
          if (!context.connected || !context.profile) {
            callbacks.current.disconnected(context.error || "机器人未连接，请在主窗口连接");
            continue;
          }
          callbacks.current.profile(context.profile);
          const hello = await bridge.attach();
          if (disposed || current !== sequence) { bridge.close(); continue; }
          const topics = await bridge.listTopics();
          if (disposed || current !== sequence) { bridge.close(); continue; }
          epoch = context.epoch;
          callbacks.current.connected(context.profile, hello, topics);
        }
      } catch (reason) {
        if (!disposed) { bridge.close(); callbacks.current.disconnected(String(reason)); }
      } finally {
        running = false;
        if (pending && !disposed) void refresh();
      }
    };
    void listen("native-session-changed", () => void refresh()).then(stop => {
      if (disposed) stop(); else { unlisten = stop; void refresh(); }
    }).catch(reason => { if (!disposed) callbacks.current.disconnected(String(reason)); });
    return () => { disposed = true; sequence++; unlisten?.(); bridge.close(); };
  }, [options.page, options.bridge]);
}

/** Navigation applies once after lazy mount; it never replaces a page's editor. */
export function useMotionNavigation(page: AppPage | undefined, intent: MotionNavigation | null | undefined,
  profileKey: string, select: (tab: "positions" | "groups") => void, error: (message: string) => void) {
  const applied = useRef(0);
  useEffect(() => {
    if (page !== "motion" || !intent || intent.revision <= applied.current) return;
    applied.current = intent.revision;
    if (intent.profile_key !== profileKey) { error("Motion 保留的是另一连接的编辑内容，请先连接所选机器人以同步配置，再重新打开编辑入口"); return; }
    select(intent.tab);
  }, [page, intent, profileKey, select, error]);
}
