import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { defaultProfile, type BridgeEnvelope } from "./types";
import { useRosControllers } from "./useRosControllers";
import type { SharedObservations } from "./nativeObservationsLogic";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke),
  request = vi.fn();
const bridge = { request };
const controller = {
  name: "arm",
  typeName: "test/Controller",
  state: "inactive",
};
let sequence = 0,
  mono = 0;
const wire = (
  state = "inactive",
  changes: Record<string, unknown> = {},
): BridgeEnvelope => ({
  op: "controllers_info",
  supported: true,
  manager: "/controller_manager",
  available: true,
  fresh: true,
  has_snapshot: true,
  snapshot_sequence: ++sequence,
  snapshot_age_ms: 0,
  snapshot_time_ms: 1793600000000,
  query_state: "ready",
  query_pending: false,
  retry_after_ms: 0,
  request_wait_ms: 0,
  controllers: [{ name: "arm", type_name: "test/Controller", state }],
  message: "",
  ...changes,
});
const options = {
  profile: defaultProfile,
  bridge,
  supported: true,
  connectionKey: "a",
  connected: true,
  getBlockReason: () => "",
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const flush = () => act(async () => {});
beforeEach(() => {
  native.mockReset();
  request.mockReset();
  sequence = 0;
  mono = 0;
  vi.spyOn(performance, "now").mockImplementation(() => mono);
  request.mockImplementation(async () => wire());
  native.mockResolvedValue("switch accepted");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("keeps background reads silent while an explicit refresh remains visibly busy through pending cache reads", async () => {
  const cache = deferred<BridgeEnvelope>(), forced = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(cache.promise).mockReturnValueOnce(forced.promise);
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  expect(hook.result.current.refreshing).toBe(false);
  let refresh!: Promise<unknown>;
  act(() => { refresh = hook.result.current.refresh(); });
  expect(hook.result.current.refreshing).toBe(true);
  await act(async () => { cache.resolve(wire()); });
  expect(hook.result.current.refreshing).toBe(true);
  await act(async () => { forced.resolve(wire("active")); await refresh; });
  expect(hook.result.current.refreshing).toBe(false);
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
});
it("does not flash refreshing during repeated background polls but reports their failures immediately", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  const next = deferred<BridgeEnvelope>(); request.mockReturnValueOnce(next.promise);
  await act(async () => { mono = 1000; await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.refreshing).toBe(false);
  expect(hook.result.current.status?.fresh).toBe(true);
  await act(async () => next.reject(new Error("read failed")));
  expect(hook.result.current.refreshing).toBe(false);
  expect(hook.result.current.status).toMatchObject({fresh:false,available:false,message:"read failed"});
});
it("reads cached state immediately and every second without native controller queries", async () => {
  vi.useFakeTimers();
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  expect(request).toHaveBeenCalledExactlyOnceWith(
    { op: "controllers_info", refresh: false },
    5500,
    expect.any(AbortSignal),
  );
  await act(async () => {
    mono = 1000;
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(request.mock.calls.map((c) => c[0].refresh)).toEqual([false, false]);
  expect(native).not.toHaveBeenCalled();
  expect(hook.result.current.status?.fresh).toBe(true);
});
it("deduplicates like requests but forces a new query after an older cache read drains", async () => {
  const cache = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(cache.promise);
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  let first!: Promise<unknown>, second!: Promise<unknown>;
  act(() => {
    first = hook.result.current.fetchStatus();
    second = hook.result.current.fetchStatus();
  });
  expect(first).toBe(second);
  await flush();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    cache.resolve(wire());
    await Promise.all([first, second]);
  });
  expect(request.mock.calls.map((c) => c[0].refresh)).toEqual([false, true]);
});
it("ignores delayed old-session responses and clears rows on disconnect", async () => {
  const old = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(old.promise).mockResolvedValue(wire("active"));
  const hook = renderHook((p) => useRosControllers(p), {
    initialProps: options,
  });
  await flush();
  hook.rerender({ ...options, connectionKey: "b" });
  await flush();
  await act(async () => old.resolve(wire("inactive")));
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
  hook.rerender({ ...options, connectionKey: "b", connected: false });
  expect(hook.result.current.status).toBeNull();
});
it("expires at the monotonic TTL even when a forced query is still pending and cached age repeats", async () => {
  vi.useFakeTimers();
  request.mockResolvedValue(wire("active", { snapshot_sequence: 1 }));
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  await act(async () => {
    mono = 3000;
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(hook.result.current.status?.fresh).toBe(true);
  await act(async () => {
    mono = 3100;
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(hook.result.current.status).toMatchObject({
    available: false,
    fresh: false,
    queryState: "stale",
    controllers: [
      { name: "arm", state: "active", typeName: "test/Controller" },
    ],
  });
});
it("includes tunnel delay in cached age and subtracts only measured server wait from forced replies", async () => {
  const cached = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(cached.promise);
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  await act(async () => {
    mono = 1200;
    cached.resolve(wire("active", { snapshot_age_ms: 2000 }));
  });
  expect(hook.result.current.status).toMatchObject({
    fresh: false,
    available: false,
    snapshotAgeMs: 3200,
  });
  const fresh = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(fresh.promise);
  let result!: Promise<unknown>;
  act(() => {
    result = hook.result.current.fetchStatus();
  });
  await flush();
  await act(async () => {
    mono = 5000;
    fresh.resolve(wire("active", { request_wait_ms: 3800 }));
    await result;
  });
  expect(hook.result.current.status).toMatchObject({
    fresh: true,
    snapshotAgeMs: 0,
  });
  const delayed = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(delayed.promise);
  act(() => {
    result = hook.result.current.fetchStatus();
  });
  await flush();
  await act(async () => {
    mono = 10800;
    delayed.resolve(
      wire("active", { request_wait_ms: 3800, snapshot_age_ms: 1200 }),
    );
    await result;
  });
  expect(hook.result.current.status).toMatchObject({
    fresh: false,
    snapshotAgeMs: 3200,
  });
});
it("retains same-session last-good rows on query failures without unlocking switching", async () => {
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  request.mockRejectedValue(new Error("ListControllers >2s"));
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(hook.result.current.status).toMatchObject({
    fresh: false,
    available: false,
    queryState: "error",
    controllers: [controller],
  });
  await act(async () => {
    await hook.result.current.switchController(controller, "activate");
  });
  expect(native).not.toHaveBeenCalled();
  expect(hook.result.current.error).toContain("ListControllers >2s");
});
it("shows an upgrade requirement for an old Bridge without falling back to CLI", async () => {
  const hook = renderHook(() =>
    useRosControllers({ ...options, supported: undefined }),
  );
  await flush();
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(hook.result.current.status).toMatchObject({
    available: false,
    fresh: false,
    queryState: "unsupported",
  });
  expect(hook.result.current.status?.message).toContain("升级 Bridge");
  expect(request).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});
it("refreshes before and after native switching and verifies fresh target state", async () => {
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  request.mockResolvedValueOnce(wire()).mockResolvedValueOnce(wire("active"));
  await act(async () => {
    await hook.result.current.switchController(controller, "activate");
  });
  expect(request.mock.calls.map((c) => c[0].refresh)).toEqual([
    false,
    true,
    true,
  ]);
  expect(native.mock.calls.map((c) => c[0])).toEqual(["switch_ros_controller"]);
  expect(hook.result.current.message).toBe("switch accepted");
});
it("drains automatic and forced reads started during a switch before dispatching post-verification", async () => {
  const switching = deferred<string>(),
    during = deferred<BridgeEnvelope>();
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  native.mockReturnValueOnce(switching.promise);
  let run!: Promise<void>, old!: Promise<unknown>;
  act(() => {
    run = hook.result.current.switchController(controller, "activate");
  });
  await flush();
  request.mockReturnValueOnce(during.promise);
  act(() => {
    old = hook.result.current.fetchStatus();
  });
  await flush();
  request.mockImplementationOnce(async () => wire("active"));
  await act(async () => switching.resolve("done"));
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => {
    during.resolve(wire());
    await old;
    await run;
  });
  expect(request.mock.calls.map((c) => c[0].refresh)).toEqual([
    false,
    true,
    true,
    true,
  ]);
  expect(hook.result.current.message).toBe("done");
});
it("rechecks operation blocks, stale states and generation after each await", async () => {
  let block = "";
  const hook = renderHook(
    (p) => useRosControllers({ ...p, getBlockReason: () => block }),
    { initialProps: options },
  );
  await flush();
  const pending = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(pending.promise);
  let run!: Promise<void>;
  act(() => {
    run = hook.result.current.switchController(controller, "activate");
  });
  await flush();
  block = "点位运动进行中";
  await act(async () => {
    pending.resolve(wire());
    await run;
  });
  expect(native).not.toHaveBeenCalled();
  expect(hook.result.current.error).toContain(block);
  block = "";
  native.mockReturnValueOnce(deferred<string>().promise);
  act(() => {
    void hook.result.current.switchController(controller, "activate");
  });
  await flush();
  hook.rerender({ ...options, connectionKey: "next" });
  await flush();
  expect(hook.result.current.action).toBeNull();
  expect(hook.result.current.message).toBe("");
});
it("preserves native switch failure while still querying actual post-state", async () => {
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  native.mockRejectedValueOnce(new Error("native rejected"));
  request.mockResolvedValueOnce(wire()).mockResolvedValueOnce(wire("active"));
  await act(async () => {
    await hook.result.current.switchController(controller, "activate");
  });
  expect(hook.result.current.error).toContain("native rejected");
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
  expect(hook.result.current.message).toBe("");
});
it("merges simultaneous manual refreshes while still dispatching a new force after the cache request", async () => {
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  const forced = deferred<BridgeEnvelope>();
  request.mockReturnValueOnce(forced.promise);
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = hook.result.current.refresh();
    second = hook.result.current.refresh();
  });
  await flush();
  expect(request.mock.calls.map((c) => c[0].refresh)).toEqual([false, true]);
  await act(async () => {
    forced.resolve(wire());
    await Promise.all([first, second]);
  });
  expect(request).toHaveBeenCalledTimes(2);
});
it("preserves the server's timeout and raw reason for an old ten-second snapshot", async () => {
  request.mockResolvedValue(
    wire("active", {
      fresh: false,
      available: false,
      snapshot_age_ms: 10000,
      query_state: "timeout",
      message: "ListControllers query 2 timed out",
      query_pending: true,
    }),
  );
  const hook = renderHook(() => useRosControllers(options));
  await flush();
  expect(hook.result.current.status).toMatchObject({
    fresh: false,
    available: false,
    queryState: "timeout",
    snapshotAgeMs: 10000,
    message: "ListControllers query 2 timed out",
    queryPending: true,
    controllers: [{ ...controller, state: "active" }],
  });
  await act(async () => {
    await hook.result.current.switchController(
      { ...controller, state: "active" },
      "deactivate",
    );
  });
  expect(native).not.toHaveBeenCalled();
  expect(hook.result.current.error).toContain(
    "ListControllers query 2 timed out",
  );
});

it("uses shared native observations without polling the Bridge and forces post-action checks through the native gate", async () => {
  vi.useFakeTimers();
  const entry = { sequence: 1, value: wire("inactive"), error: null, age_ms: 20, ttl_ms: 3100, receivedAt: 0, expired: false };
  const refresh = vi.fn().mockResolvedValue({ ...entry, sequence: 2, value: wire("active") });
  const shared = { enabled: true, connected: true, epoch: 1, revision: 1, entries: { controllers: entry }, refresh } as SharedObservations;
  const hook = renderHook((shared: SharedObservations) => useRosControllers({ ...options, shared }), { initialProps: shared });
  await flush();
  expect(hook.result.current.status?.controllers[0].state).toBe("inactive");
  expect(request).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(request).not.toHaveBeenCalled();
  await act(async () => { await hook.result.current.fetchStatus(true, true); });
  expect(refresh).toHaveBeenCalledExactlyOnceWith("controllers", true);
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
  hook.rerender({ ...shared, revision: 3, entries: { controllers: { ...entry, sequence: 3, error: "shared query failed", value: null } } });
  await flush();
  expect(hook.result.current.status).toMatchObject({ fresh: false, message: "shared query failed", controllers: [{ ...controller, state: "active" }] });
});
