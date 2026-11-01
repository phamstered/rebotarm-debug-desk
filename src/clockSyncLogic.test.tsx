import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseClockSyncInfo, useClockSync } from "./clockSyncLogic";
import type { BridgeEnvelope } from "./types";
const valid = (): BridgeEnvelope => ({ op: "clock_sync_info", supported: true, state: "synchronized", message: "反馈时间已对齐", source_topic: "/stm32/joint_states", source_offset_ms: -3, feedback_age_ms: 2, generation: 1 });
afterEach(() => vi.useRealTimers());
it("requires valid Jetson diagnostics instead of inferring synchronization from a nonzero stamp", () => {
  expect(parseClockSyncInfo(valid())).toMatchObject({ state: "synchronized", source_offset_ms: -3 });
  expect(parseClockSyncInfo({ ...valid(), state: "unsynchronized", source_offset_ms: 15400 }).state).toBe("unsynchronized");
  for (const patch of [{ source_offset_ms: NaN }, { feedback_age_ms: -1 }, { generation: 1.5 }, { state: "healthy" }, { source_offset_ms: undefined }, { firmware: { supported: true, sync_age_ms: Infinity } }])
    expect(() => parseClockSyncInfo({ ...valid(), ...patch })).toThrow();
  expect(parseClockSyncInfo({ op: "clock_sync_info", supported: false }).state).toBe("unsupported");
});
it("uses one in-flight request, expires stale status, and recovers from valid responses", async () => {
  vi.useFakeTimers();
  let finish!: (reply: BridgeEnvelope) => void;
  const request = vi.fn().mockResolvedValueOnce(valid()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(valid());
  const bridge = { request };
  const hook = renderHook(() => useClockSync(bridge, true, "a"));
  await act(async () => {});
  expect(hook.result.current.state).toBe("synchronized");
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(request).toHaveBeenCalledTimes(2);
  expect(hook.result.current.state).toBe("stale");
  await act(async () => finish(valid()));
  expect(hook.result.current.state).toBe("stale"); // Response took >=2s; cannot restore stale state.
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(hook.result.current.state).toBe("synchronized");
  hook.unmount();
});
it("isolates late responses across profile changes and clears on disconnect", async () => {
  let finish!: (reply: BridgeEnvelope) => void;
  const bridge = { request: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ...valid(), state: "unsynchronized", message: "超前 15 秒" }) };
  const second = renderHook(({ connected, key }) => useClockSync(bridge, connected, key), { initialProps: { connected: true, key: "a" } });
  second.rerender({ connected: true, key: "b" });
  await act(async () => {});
  expect(second.result.current.state).toBe("unsynchronized");
  await act(async () => finish(valid()));
  expect(second.result.current.message).toBe("超前 15 秒");
  second.rerender({ connected: false, key: "b" });
  expect(second.result.current.state).toBe("disconnected");
  second.unmount();
});
it("stops retrying an unsupported old Bridge without logging repeated errors", async () => {
  vi.useFakeTimers();
  const bridge = { request: vi.fn().mockRejectedValue(new Error("未知操作：clock_sync_info")) };
  const hook = renderHook(() => useClockSync(bridge, true, "a"));
  await act(async () => {});
  expect(hook.result.current.state).toBe("unsupported");
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(bridge.request).toHaveBeenCalledOnce();
  hook.unmount();
});

it("ignores abort rejection after reconnecting the same profile", async () => {
  let reject!: (error: Error) => void;
  const bridge = { request: vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(valid()) };
  const hook = renderHook(({ connected }) => useClockSync(bridge, connected, "a"), { initialProps: { connected: true } });
  hook.rerender({ connected: false });
  hook.rerender({ connected: true });
  await act(async () => {});
  expect(hook.result.current.state).toBe("synchronized");
  await act(async () => reject(new Error("已取消请求")));
  expect(hook.result.current.state).toBe("synchronized");
  hook.unmount();
});
