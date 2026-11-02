import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BridgeClient } from "./bridge";
import type {
  ConnectionProfile,
  ControllerInfo,
  RosControlStatus,
} from "./types";
import type {
  ControllerAction,
  ControllerSwitchAction,
} from "./MotionControllersPanel";
import {
  CONTROLLER_CACHE_POLL_MS,
  CONTROLLER_SNAPSHOT_TTL_MS,
  controllerStatusFresh,
  parseControllersInfo,
} from "./controllersInfoLogic";
type View = {
  status: RosControlStatus | null;
  refreshing: boolean;
  action: ControllerAction | null;
  message: string;
  error: string;
};
const empty = (): View => ({
  status: null,
  refreshing: false,
  action: null,
  message: "",
  error: "",
});
const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export function useRosControllers({
  profile,
  bridge,
  supported,
  connected,
  connectionKey,
  getBlockReason,
}: {
  profile: ConnectionProfile;
  bridge: Pick<BridgeClient, "request">;
  supported?: boolean;
  connected: boolean;
  connectionKey: string | number;
  getBlockReason(): string;
}) {
  const blockRef = useRef(getBlockReason);
  blockRef.current = getBlockReason;
  const signature = JSON.stringify(profile);
  const context = useMemo(
    () => ({
      valid: connected,
      revision: 0,
      pending: new Set<Promise<RosControlStatus>>(),
      explicitPending: new Set<Promise<RosControlStatus>>(),
      cache: null as Promise<RosControlStatus> | null,
      force: null as Promise<RosControlStatus> | null,
      switching: false,
      profile,
      status: null as RosControlStatus | null,
      at: 0,
      abort: new AbortController(),
      expiry: null as number | null,
    }),
    [signature, bridge, supported, connected, connectionKey],
  );
  const [snapshot, setSnapshot] = useState<{
    context: typeof context;
    value: View;
  } | null>(null);
  const update = useCallback(
    (change: (value: View) => View, revision = context.revision) => {
      if (!context.valid || context.revision !== revision) return;
      setSnapshot((old) =>
        context.valid && context.revision === revision
          ? {
              context,
              value: change(old?.context === context ? old.value : empty()),
            }
          : old,
      );
    },
    [context],
  );
  const aged = useCallback(() => {
    const status = context.status;
    if (!status) return null;
    const age = status.hasSnapshot
      ? (status.snapshotAgeMs ?? 0) +
        Math.max(0, performance.now() - context.at)
      : undefined;
    const expired = age !== undefined && age >= CONTROLLER_SNAPSHOT_TTL_MS;
    return {
      ...status,
      snapshotAgeMs: age,
      ...(expired
        ? {
            available: false,
            fresh: false,
            queryState: status.fresh ? ("stale" as const) : status.queryState,
            message: status.fresh
              ? "Controller 快照已过期；保留上次列表供只读查看"
              : status.message,
          }
        : {}),
    };
  }, [context]);
  const publish = useCallback(
    (status: RosControlStatus, revision = context.revision) => {
      if (!context.valid || context.revision !== revision) return;
      context.status = status;
      context.at = performance.now();
      if (context.expiry !== null) window.clearTimeout(context.expiry);
      context.expiry = null;
      if (status.fresh && status.snapshotAgeMs !== undefined)
        context.expiry = window.setTimeout(
          () => {
            const expired = aged();
            if (expired)
              update((old) => ({ ...old, status: expired }), revision);
          },
          Math.max(
            0,
            Math.ceil(CONTROLLER_SNAPSHOT_TTL_MS - status.snapshotAgeMs),
          ),
        );
      update((old) => ({ ...old, status }), revision);
    },
    [context, update, aged],
  );
  const failStatus = useCallback(
    (message: string, unsupported = false): RosControlStatus => {
      const previous = aged();
      return {
        ...(previous ?? {
          manager: "/controller_manager",
          controllers: [],
          hasSnapshot: false,
          snapshotSequence: 0,
        }),
        supported: !unsupported,
        available: false,
        fresh: false,
        queryState: unsupported ? "unsupported" : "error",
        queryPending: false,
        retryAfterMs: 0,
        message,
      };
    },
    [aged],
  );
  useEffect(() => {
    context.valid = connected;
    return () => {
      context.valid = false;
      ++context.revision;
      context.abort.abort();
      if (context.expiry !== null) window.clearTimeout(context.expiry);
    };
  }, [context, connected]);
  const reset = useCallback(() => {
    ++context.revision;
    context.abort.abort();
    context.abort = new AbortController();
    context.pending.clear();
    context.explicitPending.clear();
    context.cache = null;
    context.force = null;
    context.status = null;
    setSnapshot({ context, value: empty() });
  }, [context]);
  const setStatus: Dispatch<SetStateAction<RosControlStatus | null>> =
    useCallback(
      (value) => {
        const next = typeof value === "function" ? value(aged()) : value;
        if (next) publish(next);
        else {
          context.status = null;
          update((old) => ({ ...old, status: null }));
        }
      },
      [context, aged, publish, update],
    );
  const fetchStatus = useCallback(
    (refresh = true, afterPending = false): Promise<RosControlStatus> => {
      if (!context.valid) return Promise.reject(new Error("请先连接 Jetson"));
      if (supported !== true) {
        const status = failStatus(
          "当前 Bridge 不支持常驻 Controller 查询，请升级 Bridge",
          true,
        );
        publish(status);
        return Promise.resolve(status);
      }
      if (refresh && !afterPending && context.force) return context.force;
      if (!refresh && (context.force || context.cache))
        return (context.force || context.cache)!;
      const revision = context.revision;
      const before = refresh ? [...context.pending] : [];
      if (refresh) update((old) => ({ ...old, refreshing: true }), revision);
      const query = Promise.allSettled(before)
        .then(async () => {
          if (!context.valid || context.revision !== revision)
            throw new Error("连接已改变，忽略旧控制器查询");
          const sentAt = performance.now();
          const response = await bridge.request(
            { op: "controllers_info", refresh },
            5500,
            context.abort.signal,
          );
          if (!context.valid || context.revision !== revision)
            throw new Error("连接已改变，忽略旧控制器查询");
          let status = parseControllersInfo(response);
          if (status.hasSnapshot)
            status = {
              ...status,
              snapshotAgeMs:
                status.snapshotAgeMs! +
                Math.max(
                  0,
                  performance.now() - sentAt - (status.requestWaitMs ?? 0),
                ),
            };
          const previous = aged();
          if (previous?.hasSnapshot && status.hasSnapshot) {
            if (status.snapshotSequence! < previous.snapshotSequence!)
              throw new Error("Controller 快照序列倒退");
            if (status.snapshotSequence === previous.snapshotSequence)
              status = {
                ...status,
                snapshotAgeMs: Math.max(
                  status.snapshotAgeMs!,
                  previous.snapshotAgeMs!,
                ),
              };
          }
          if (
            status.fresh && status.hasSnapshot &&
            status.snapshotAgeMs! >= CONTROLLER_SNAPSHOT_TTL_MS
          )
            status = {
              ...status,
              available: false,
              fresh: false,
              queryState: "stale",
              message: "Controller 快照已过期；保留上次列表供只读查看",
            };
          // Keep a last good snapshot through transient query failures in this session only.
          if (
            !status.hasSnapshot &&
            previous?.hasSnapshot &&
            status.supported !== false
          )
            status = {
              ...status,
              controllers: previous.controllers,
              hasSnapshot: true,
              snapshotSequence: previous.snapshotSequence,
              snapshotAgeMs: previous.snapshotAgeMs,
              snapshotTimeMs: previous.snapshotTimeMs,
            };
          publish(status, revision);
          return status;
        })
        .catch((error) => {
          publish(failStatus(text(error)), revision);
          throw error;
        })
        .finally(() => {
          context.pending.delete(query);
          context.explicitPending.delete(query);
          if (context.cache === query) context.cache = null;
          if (context.force === query) context.force = null;
          update(
            (old) => ({ ...old, refreshing: context.explicitPending.size > 0 }),
            revision,
          );
        });
      context.pending.add(query);
      if (refresh) context.explicitPending.add(query);
      if (refresh) context.force = query;
      else context.cache = query;
      return query;
    },
    [context, supported, bridge, update, publish, failStatus, aged],
  );
  const refresh = useCallback(async () => {
    try {
      await fetchStatus(true);
    } catch {
      /* Read-only failure is visible in status. */
    }
  }, [fetchStatus]);
  useEffect(() => {
    if (!connected) return;
    void fetchStatus(false).catch(() => {});
    const timer = window.setInterval(
      () => void fetchStatus(false).catch(() => {}),
      CONTROLLER_CACHE_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [connected, fetchStatus, aged, update]);
  const switchController = useCallback(
    async (controller: ControllerInfo, action: ControllerSwitchAction) => {
      if (context.switching) return;
      const revision = context.revision;
      const check = () => {
        if (!context.valid || context.revision !== revision)
          throw new Error("连接已改变，控制器操作已失效");
        const reason = blockRef.current();
        if (reason) throw new Error(reason);
      };
      try {
        check();
      } catch (error) {
        update(
          (old) => ({ ...old, error: text(error), message: "" }),
          revision,
        );
        return;
      }
      context.switching = true;
      update(
        (old) => ({
          ...old,
          action: { name: controller.name, action },
          message: "",
          error: "",
        }),
        revision,
      );
      let sent = false,
        nativeMessage = "",
        failure = "";
      try {
        const before = await fetchStatus(true, true);
        check();
        const actual = before.controllers.find(
          (c) => c.name === controller.name,
        );
        if (!controllerStatusFresh(before) || !actual)
          throw new Error(
            before.message || "Controller 状态未确认新鲜，请刷新列表",
          );
        if (
          actual.typeName !== controller.typeName ||
          !["active", "inactive"].includes(actual.state)
        )
          throw new Error("Controller 类型或状态已改变，禁止切换");
        const target = action === "activate" ? "active" : "inactive";
        if (actual.state === target)
          throw new Error(`${controller.name} 已处于 ${target}，未发送切换`);
        check();
        sent = true;
        try {
          nativeMessage = await invoke<string>("switch_ros_controller", {
            profile: context.profile,
            controllerName: controller.name,
            action,
          });
        } catch (error) {
          failure = text(error);
        }
        if (!context.valid || context.revision !== revision) return;
        try {
          const after = await fetchStatus(true, true);
          const verified = after.controllers.find(
            (c) =>
              c.name === controller.name && c.typeName === controller.typeName,
          );
          if (!controllerStatusFresh(after) || verified?.state !== target)
            throw new Error(
              `切换后未确认 ${controller.name} 为 ${target}：${after.message}`,
            );
        } catch (error) {
          failure = [failure, text(error)].filter(Boolean).join("；");
        }
        if (failure) throw new Error(failure);
        update(
          (old) => ({
            ...old,
            message: nativeMessage || `${controller.name} 已确认 ${target}`,
            error: "",
          }),
          revision,
        );
      } catch (error) {
        update(
          (old) => ({
            ...old,
            error: `${sent ? "控制器操作未确认：" : ""}${text(error)}`,
            message: "",
          }),
          revision,
        );
      } finally {
        context.switching = false;
        update((old) => ({ ...old, action: null }), revision);
      }
    },
    [context, update, fetchStatus],
  );
  const value =
    snapshot?.context === context && connected ? snapshot.value : empty();
  return {
    ...value,
    setStatus,
    reset,
    clear: reset,
    refresh,
    fetchStatus,
    switchController,
  };
}
