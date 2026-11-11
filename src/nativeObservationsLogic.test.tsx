import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observationEnvelope, observationValue, useNativeObservations, type ObservationSnapshot, type NativeObservation } from "./nativeObservationsLogic";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); }) }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const snapshot = (revision = 1, epoch = 1): ObservationSnapshot => ({ epoch, revision, connected: true, entries: { agent: { sequence: revision, value: { activeState: "active" }, error: null, age_ms: 100, ttl_ms: 8000 } } });
const changed = () => { mocks.listeners.forEach(listener => listener()); };
beforeEach(() => { mocks.invoke.mockReset(); mocks.listeners.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("nine windows read snapshots without creating per-window remote polling loops", async () => {
  vi.useFakeTimers();
  mocks.invoke.mockResolvedValue(snapshot());
  const windows = Array.from({ length: 9 }, () => renderHook(() => useNativeObservations(true, "robot")));
  await act(async () => {});
  expect(mocks.invoke).toHaveBeenCalledTimes(9);
  expect(mocks.invoke.mock.calls.every(([command]) => command === "native_observation_snapshot")).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(mocks.invoke).toHaveBeenCalledTimes(9);
  mocks.invoke.mockResolvedValue(snapshot(2));
  await act(async () => changed());
  expect(windows.every(window => window.result.current.entries.agent?.sequence === 2)).toBe(true);
  windows.forEach(window => window.unmount());
  expect(mocks.listeners.size).toBe(0);
});

it("coalesces native invalidations and cannot replace newer state with a delayed initial read", async () => {
  const initial = deferred<ObservationSnapshot>();
  mocks.invoke.mockReturnValueOnce(initial.promise).mockResolvedValue(snapshot(3));
  const hook = renderHook(() => useNativeObservations(true, "robot"));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  act(() => { changed(); changed(); changed(); });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => initial.resolve(snapshot(1)));
  await waitFor(() => expect(hook.result.current.revision).toBe(3));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("keeps age through IPC, expires independently of redraw, and does not count server wait twice", async () => {
  vi.useFakeTimers();
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  mocks.invoke.mockResolvedValue(snapshot());
  const hook = renderHook(() => useNativeObservations(true, "robot"));
  await act(async () => {});
  const reply = deferred<ObservationSnapshot>(); mocks.invoke.mockReturnValueOnce(reply.promise);
  let refresh!: Promise<NativeObservation>;
  act(() => { refresh = hook.result.current.refresh("agent", true); });
  expect(mocks.invoke).toHaveBeenLastCalledWith("native_observation_refresh", { source: "agent", epoch: 1, afterPending: true });
  now = 5100;
  await act(async () => { reply.resolve({ ...snapshot(2), handler_elapsed_ms: 5000 }); await refresh; });
  expect(hook.result.current.entries.agent?.age_ms).toBe(200);
  expect(observationValue(hook.result.current.entries.agent)).toEqual({ activeState: "active" });
  now = 12900;
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(hook.result.current.entries.agent?.expired).toBe(true);
  expect(() => observationValue(hook.result.current.entries.agent)).toThrow("过期");
});

it("clears old values on disconnect and rejects late manual results across session changes", async () => {
  mocks.invoke.mockResolvedValue(snapshot());
  const hook = renderHook((key: string) => useNativeObservations(true, key), { initialProps: "old" });
  await waitFor(() => expect(hook.result.current.connected).toBe(true));
  const old = deferred<ObservationSnapshot>(); mocks.invoke.mockReturnValueOnce(old.promise);
  let refresh!: Promise<NativeObservation>;
  act(() => { refresh = hook.result.current.refresh("agent"); });
  const rejection = expect(refresh).rejects.toThrow("会话已改变");
  mocks.invoke.mockResolvedValue({ epoch: 2, revision: 3, connected: false, entries: {} });
  hook.rerender("new");
  await waitFor(() => expect(hook.result.current.epoch).toBe(2));
  await act(async () => { old.resolve(snapshot(2)); await rejection; });
  expect(hook.result.current.entries).toEqual({});
  expect(hook.result.current.connected).toBe(false);
});

it("fails closed on shared query errors and aged controller snapshots", () => {
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const entry: NativeObservation = { sequence: 1, value: { op: "controllers_info", fresh: true, available: true, snapshot_age_ms: 2500, request_wait_ms: 2000 }, error: null, age_ms: 500, ttl_ms: 3100, receivedAt: 500, expired: false };
  expect(observationEnvelope(entry)).toMatchObject({ snapshot_age_ms: 3500, fresh: false, available: false, query_state: "stale", request_wait_ms: 0, desktop_received_at_ms: 0 });
  expect(() => observationValue({ ...entry, error: "SSH gone" })).toThrow("SSH gone");
});

it("does not subscribe, read or refresh when no native connection is active", async () => {
  const hook = renderHook(() => useNativeObservations(false, "robot"));
  await act(async () => {});
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.listeners.size).toBe(0);
  await expect(hook.result.current.refresh("agent")).rejects.toThrow("请先连接");
});
