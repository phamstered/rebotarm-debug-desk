import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionProfile, ControllerInfo, RosControlStatus } from "./types";
import type { ControllerAction, ControllerSwitchAction } from "./MotionControllersPanel";
type View = { status: RosControlStatus | null; refreshing: boolean; action: ControllerAction | null; message: string; error: string };
const empty = (): View => ({ status: null, refreshing: false, action: null, message: "", error: "" });
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
export function useRosControllers({ profile, connected, connectionKey, getBlockReason }: {
  profile: ConnectionProfile; connected: boolean; connectionKey: string | number; getBlockReason(): string;
}) {
  const blockRef = useRef(getBlockReason); blockRef.current = getBlockReason;
  const signature = JSON.stringify(profile);
  const context = useMemo(() => ({ valid: connected, revision: 0, pending: null as Promise<RosControlStatus> | null, switching: false, profile }), [signature, connected, connectionKey]);
  const [snapshot, setSnapshot] = useState<{ context: typeof context; value: View } | null>(null);
  const update = useCallback((change: (value: View) => View, revision = context.revision) => {
    if (!context.valid || context.revision !== revision) return;
    setSnapshot(old => context.valid && context.revision === revision ? { context, value: change(old?.context === context ? old.value : empty()) } : old);
  }, [context]);
  useEffect(() => { context.valid = connected; return () => { context.valid = false; ++context.revision; }; }, [context, connected]);
  const reset = useCallback(() => { ++context.revision; context.pending = null; setSnapshot({ context, value: empty() }); }, [context]);
  const setStatus: Dispatch<SetStateAction<RosControlStatus | null>> = useCallback(value => update(old => ({ ...old, status: typeof value === "function" ? value(old.status) : value })), [update]);
  const fetchStatus = useCallback((): Promise<RosControlStatus> => {
    if (!context.valid) return Promise.reject(new Error("请先连接 Jetson"));
    if (context.pending) return context.pending;
    const revision = context.revision;
    update(old => ({ ...old, refreshing: true }), revision);
    const query = Promise.resolve().then(() => invoke<RosControlStatus>("check_ros_controllers", { profile: context.profile })).then(status => {
      if (!context.valid || context.revision !== revision) throw new Error("连接已改变，忽略旧控制器查询");
      if (!status || typeof status.available !== "boolean" || !Array.isArray(status.controllers) || status.controllers.some(c => typeof c.name !== "string" || typeof c.typeName !== "string" || typeof c.state !== "string")) throw new Error("Controller 列表响应无效");
      update(old => ({ ...old, status }), revision); return status;
    }).catch(error => {
      update(old => ({ ...old, status: { manager: "/controller_manager", available: false, controllers: [], message: text(error) } }), revision);
      throw error;
    }).finally(() => {
      if (context.pending === query) context.pending = null;
      update(old => ({ ...old, refreshing: false }), revision);
    });
    context.pending = query;
    return query;
  }, [context, update]);
  const refresh = useCallback(async () => { try { await fetchStatus(); } catch { /* Status contains the read-only query failure. */ } }, [fetchStatus]);
  const switchController = useCallback(async (controller: ControllerInfo, action: ControllerSwitchAction) => {
    if (context.switching) return;
    const revision = context.revision;
    const check = () => {
      if (!context.valid || context.revision !== revision) throw new Error("连接已改变，控制器操作已失效");
      const reason = blockRef.current(); if (reason) throw new Error(reason);
    };
    try { check(); } catch (error) { update(old => ({ ...old, error: text(error), message: "" }), revision); return; }
    context.switching = true;
    update(old => ({ ...old, action: { name: controller.name, action }, message: "", error: "" }), revision);
    let sent = false, nativeMessage = "", failure = "";
    try {
      const before = await fetchStatus(); check();
      const actual = before.controllers.find(c => c.name === controller.name);
      if (!before.available || !actual) throw new Error("Controller 不存在或 Manager 不可用，请刷新列表");
      if (actual.typeName !== controller.typeName || !["active", "inactive"].includes(actual.state)) throw new Error("Controller 类型或状态已改变，禁止切换");
      const target = action === "activate" ? "active" : "inactive";
      if (actual.state === target) throw new Error(`${controller.name} 已处于 ${target}，未发送切换`);
      check(); sent = true;
      try { nativeMessage = await invoke<string>("switch_ros_controller", { profile: context.profile, controllerName: controller.name, action }); }
      catch (error) { failure = text(error); }
      if (!context.valid || context.revision !== revision) return;
      try {
        // An automatic refresh started during the native switch can contain a
        // pre-switch snapshot. Drain it, then start an actual post-switch query.
        if (context.pending) { try { await context.pending; } catch { /* Recheck below. */ } }
        if (!context.valid || context.revision !== revision) return;
        const after = await fetchStatus();
        const verified = after.controllers.find(c => c.name === controller.name && c.typeName === controller.typeName);
        if (!after.available || verified?.state !== target) throw new Error(`切换后未确认 ${controller.name} 为 ${target}`);
      } catch (error) { failure = [failure, text(error)].filter(Boolean).join("；"); }
      if (failure) throw new Error(failure);
      update(old => ({ ...old, message: nativeMessage || `${controller.name} 已确认 ${target}`, error: "" }), revision);
    } catch (error) { update(old => ({ ...old, error: `${sent ? "控制器操作未确认：" : ""}${text(error)}`, message: "" }), revision); }
    finally {
      context.switching = false;
      update(old => ({ ...old, action: null }), revision);
    }
  }, [context, update, fetchStatus]);
  const value = snapshot?.context === context && connected ? snapshot.value : empty();
  return { ...value, setStatus, reset, clear: reset, refresh, fetchStatus, switchController };
}
