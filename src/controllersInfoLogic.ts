import type { RosControlStatus } from "./types";
export const CONTROLLER_SNAPSHOT_TTL_MS = 3100;
export const CONTROLLER_CACHE_POLL_MS = 1000;
export type ControllerQueryState =
  | "waiting"
  | "ready"
  | "pending"
  | "timeout"
  | "unavailable"
  | "error"
  | "stale"
  | "unsupported";
const states: ControllerQueryState[] = [
  "waiting",
  "ready",
  "pending",
  "timeout",
  "unavailable",
  "error",
  "stale",
  "unsupported",
];
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const nonnegative = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const text = (v: unknown, max = 1024): v is string =>
  typeof v === "string" &&
  !!v.trim() &&
  v === v.trim() &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
export function parseControllersInfo(value: unknown): RosControlStatus {
  const fail = (): never => {
    throw new Error("Controller 列表响应无效，请更新 Bridge 或检查连接");
  };
  if (
    !object(value) ||
    value.op !== "controllers_info" ||
    value.manager !== "/controller_manager" ||
    typeof value.supported !== "boolean" ||
    typeof value.available !== "boolean" ||
    typeof value.fresh !== "boolean" ||
    value.available !== value.fresh ||
    typeof value.has_snapshot !== "boolean" ||
    !Number.isSafeInteger(value.snapshot_sequence) ||
    !nonnegative(value.snapshot_sequence) ||
    !states.includes(value.query_state as ControllerQueryState) ||
    typeof value.query_pending !== "boolean" ||
    !nonnegative(value.retry_after_ms) ||
    !nonnegative(value.request_wait_ms) ||
    value.request_wait_ms > 5000 ||
    typeof value.message !== "string" ||
    value.message.length > 16384 ||
    !Array.isArray(value.controllers) ||
    value.controllers.length > 4096
  )
    return fail();
  if (
    value.has_snapshot
      ? value.snapshot_sequence < 1 ||
        !nonnegative(value.snapshot_age_ms) ||
        !nonnegative(value.snapshot_time_ms)
      : value.snapshot_sequence !== 0 ||
        value.snapshot_age_ms !== undefined ||
        value.snapshot_time_ms !== undefined ||
        value.controllers.length !== 0 ||
        value.fresh
  )
    return fail();
  if (
    value.fresh &&
    !["ready", "pending"].includes(value.query_state as string)
  )
    return fail();
  if (
    (value.query_state === "pending" && !value.query_pending) ||
    (value.query_state === "ready" && value.query_pending)
  )
    return fail();
  if (
    value.fresh &&
    (!value.supported ||
      !value.has_snapshot ||
      (value.snapshot_age_ms as number) >= CONTROLLER_SNAPSHOT_TTL_MS)
  )
    return fail();
  if (
    !value.supported &&
    (value.query_state !== "unsupported" ||
      value.fresh ||
      value.query_pending ||
      value.has_snapshot)
  )
    return fail();
  if (value.supported && value.query_state === "unsupported") return fail();
  const names = new Set<string>();
  const controllers = value.controllers.map((raw) => {
    if (
      !object(raw) ||
      !text(raw.name) ||
      !text(raw.type_name) ||
      !text(raw.state, 64)
    )
      return fail();
    const canonical = raw.name.replace(/^\/+/, "");
    if (!canonical || names.has(canonical)) return fail();
    names.add(canonical);
    return { name: raw.name, typeName: raw.type_name, state: raw.state };
  });
  return {
    manager: value.manager,
    available: value.available,
    fresh: value.fresh,
    supported: value.supported,
    hasSnapshot: value.has_snapshot,
    snapshotSequence: value.snapshot_sequence,
    snapshotAgeMs: value.snapshot_age_ms as number | undefined,
    snapshotTimeMs: value.snapshot_time_ms as number | undefined,
    queryState: value.query_state as ControllerQueryState,
    queryPending: value.query_pending,
    retryAfterMs: value.retry_after_ms,
    requestWaitMs: value.request_wait_ms as number,
    controllers,
    message: value.message,
  };
}
export function controllerStatusFresh(
  status: RosControlStatus | null | undefined,
): status is RosControlStatus & { available: true; fresh: true } {
  return status?.available === true && status.fresh === true;
}
export function controllerStatusLabel(
  status: RosControlStatus | null | undefined,
): string {
  if (!status) return "等待查询";
  if (status.supported === false || status.queryState === "unsupported")
    return "需升级 Bridge";
  if (controllerStatusFresh(status))
    return `${status.controllers.length} 个 · 最新`;
  if (status.queryState === "stale") return "已过期";
  if (status.queryState === "pending" || status.queryState === "waiting")
    return "等待查询";
  if (status.queryState === "timeout") return "查询超时";
  if (status.queryState === "error") return "查询失败";
  return "服务不可用";
}
