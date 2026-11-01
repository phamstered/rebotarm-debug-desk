import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { defaultProfile } from "./types";
import { useRosControllers } from "./useRosControllers";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
const controller = { name: "arm", typeName: "test/Controller", state: "inactive" };
const status = (state = "inactive") => ({ manager: "/controller_manager", available: true, message: "", controllers: [{ ...controller, state }] });
const options = { profile: defaultProfile, connectionKey: "a", connected: true, getBlockReason: () => "" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => native.mockReset());
it("deduplicates concurrent queries and excludes late results after reconnect", async () => {
  const old = deferred<ReturnType<typeof status>>(); native.mockReturnValueOnce(old.promise).mockResolvedValue(status("active"));
  const hook = renderHook(p => useRosControllers(p), { initialProps: options });
  let first!: Promise<unknown>, second!: Promise<unknown>;
  act(() => { first = hook.result.current.fetchStatus().catch(() => {}); second = hook.result.current.fetchStatus().catch(() => {}); });
  await act(async () => {}); expect(native).toHaveBeenCalledTimes(1);
  hook.rerender({ ...options, connectionKey: "b" });
  await act(async () => { await hook.result.current.refresh(); });
  await act(async () => { old.resolve(status()); await Promise.all([first, second]); });
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
});
it("refreshes before and after switching and verifies the real target state", async () => {
  native.mockResolvedValueOnce(status()).mockResolvedValueOnce("switch accepted").mockResolvedValueOnce(status("active"));
  const hook = renderHook(() => useRosControllers(options));
  await act(async () => { await hook.result.current.switchController(controller, "activate"); });
  expect(native.mock.calls.map(c => c[0])).toEqual(["check_ros_controllers", "switch_ros_controller", "check_ros_controllers"]);
  expect(hook.result.current.message).toBe("switch accepted"); expect(hook.result.current.action).toBeNull();
  native.mockResolvedValueOnce(status()).mockResolvedValueOnce("accepted").mockResolvedValueOnce(status());
  await act(async () => { await hook.result.current.switchController(controller, "activate"); });
  expect(hook.result.current.message).toBe(""); expect(hook.result.current.error).toContain("未确认");
});
it("rechecks the current motion block after the preflight query and excludes parallel switches", async () => {
  const query = deferred<ReturnType<typeof status>>(); native.mockReturnValueOnce(query.promise);
  let block = "";
  const hook = renderHook(() => useRosControllers({ ...options, getBlockReason: () => block }));
  let run!: Promise<void>;
  act(() => { run = hook.result.current.switchController(controller, "activate"); void hook.result.current.switchController(controller, "activate"); });
  await act(async () => {}); block = "点位运动进行中";
  await act(async () => { query.resolve(status()); await run; });
  expect(native.mock.calls.map(c => c[0])).toEqual(["check_ros_controllers"]); expect(hook.result.current.error).toContain(block);
});
it("refuses unknown states and disconnection, preserving explicit query failures", async () => {
  native.mockResolvedValueOnce(status("unconfigured"));
  const hook = renderHook(p => useRosControllers(p), { initialProps: options });
  await act(async () => { await hook.result.current.switchController(controller, "activate"); });
  expect(hook.result.current.error).toContain("禁止切换"); expect(native).toHaveBeenCalledTimes(1);
  native.mockRejectedValueOnce(new Error("SSH offline")); await act(async () => { await hook.result.current.refresh(); });
  expect(hook.result.current.status?.available).toBe(false); expect(hook.result.current.status?.message).toContain("SSH offline");
  hook.rerender({ ...options, connected: false });
  await act(async () => { await hook.result.current.switchController(controller, "activate"); });
  expect(native).toHaveBeenCalledTimes(2); expect(hook.result.current.status).toBeNull();
});
it("does not reuse an automatic query started during native switching as post-switch verification", async () => {
  const switching = deferred<string>(), during = deferred<ReturnType<typeof status>>();
  native.mockResolvedValueOnce(status()).mockReturnValueOnce(switching.promise).mockReturnValueOnce(during.promise).mockResolvedValueOnce(status("active"));
  const hook = renderHook(() => useRosControllers(options)); let run!: Promise<void>, refresh!: Promise<void>;
  await act(async () => { run = hook.result.current.switchController(controller, "activate"); });
  await act(async () => { refresh = hook.result.current.refresh(); });
  await act(async () => switching.resolve("done"));
  await act(async () => { during.resolve(status()); await refresh; await run; });
  expect(native.mock.calls.filter(c => c[0] === "check_ros_controllers")).toHaveLength(3);
  expect(hook.result.current.message).toBe("done"); expect(hook.result.current.status?.controllers[0].state).toBe("active");
});
it("does not report success from an old native operation after the connection changes", async () => {
  const switching = deferred<string>();
  native.mockResolvedValueOnce(status()).mockReturnValueOnce(switching.promise).mockResolvedValueOnce(status("active"));
  const hook = renderHook(p => useRosControllers(p), { initialProps: options }); let run!: Promise<void>;
  await act(async () => { run = hook.result.current.switchController(controller, "activate"); });
  expect(hook.result.current.action).not.toBeNull();
  hook.rerender({ ...options, connectionKey: "next" });
  await act(async () => { await hook.result.current.refresh(); });
  await act(async () => { switching.resolve("old success"); await run; });
  expect(hook.result.current.message).toBe(""); expect(hook.result.current.action).toBeNull();
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
});
it("refreshes real controller state after native failure without claiming success", async () => {
  native.mockResolvedValueOnce(status()).mockRejectedValueOnce(new Error("native rejected")).mockResolvedValueOnce(status("active"));
  const hook = renderHook(() => useRosControllers(options));
  await act(async () => { await hook.result.current.switchController(controller, "activate"); });
  expect(hook.result.current.error).toContain("native rejected"); expect(hook.result.current.message).toBe("");
  expect(hook.result.current.status?.controllers[0].state).toBe("active");
});
