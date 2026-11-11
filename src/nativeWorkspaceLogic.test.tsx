import { useMotionNavigation, pageWindowVisible } from "./nativeWorkspaceLogic";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "./bridge";
import { defaultProfile } from "./types";
import { hostedPageFromSearch, useNativePageSession, useNativeWorkspace } from "./nativeWorkspaceLogic";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), events: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.events.clear();
  mocks.listen.mockReset().mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
    mocks.events.set(name, callback);
    return () => { if (mocks.events.get(name) === callback) mocks.events.delete(name); };
  });
});
afterEach(cleanup);
describe("native page routing", () => {
  it("only accepts the nine known feature identifiers", () => {
    for (const page of ["status", "dashboard", "motion", "monitor", "collection", "handeye", "motor", "calibration", "gravity"]) expect(hostedPageFromSearch(`?page=${page}`)).toBe(page);
    for (const search of ["", "?page=main", "?page=../../motor", "?page=Motion", "?page=connect"]) expect(hostedPageFromSearch(search)).toBeUndefined();
  });
  it("does not overwrite a newer workspace event with a late initial snapshot", async () => {
    const initial = deferred<unknown>(); mocks.invoke.mockReturnValue(initial.promise);
    const { result } = renderHook(() => useNativeWorkspace(true));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_snapshot"));
    act(() => mocks.events.get("workspace-state")!({ payload: { selected: "motion", pages: { motion: { detached: true, visible: true, ready: true, busy_reason: "" } } } }));
    await act(async () => initial.resolve({ selected: "status", pages: {} }));
    expect(result.current.snapshot.selected).toBe("motion");
    expect(result.current.snapshot.pages.motion?.detached).toBe(true);
  });
});
describe("page session attachment", () => {
  function setup() {
    let context = { epoch: 1, connected: true, profile: defaultProfile, error: null as string | null };
    mocks.invoke.mockImplementation(async (op: string) => { if (op !== "native_bridge_context") throw new Error(`Unexpected ${op}`); return { ...context }; });
    const client = { attach: vi.fn().mockResolvedValue({ bridge_build_id: "build" }), close: vi.fn(), listTopics: vi.fn().mockResolvedValue([]) };
    const handlers = { reset: vi.fn(), profile: vi.fn(), connected: vi.fn(), disconnected: vi.fn() };
    const options = { page: "handeye" as const, bridge: client as unknown as BridgeClient, ...handlers };
    return { client, handlers, options, context };
  }
  it("reattaches across epochs without creating a second tunnel, and ignores duplicate session notifications", async () => {
    const { client, handlers, options, context } = setup();
    const { unmount } = renderHook(() => useNativePageSession(options));
    await waitFor(() => expect(handlers.connected).toHaveBeenCalledTimes(1));
    await act(async () => mocks.events.get("native-session-changed")!({ payload: null }));
    expect(client.attach).toHaveBeenCalledTimes(1);
    context.connected = false; context.epoch++;
    await act(async () => mocks.events.get("native-session-changed")!({ payload: null }));
    expect(handlers.disconnected).toHaveBeenCalledOnce();
    context.connected = true; context.epoch++;
    await act(async () => mocks.events.get("native-session-changed")!({ payload: null }));
    await waitFor(() => expect(handlers.connected).toHaveBeenCalledTimes(2));
    expect(client.attach.mock.calls).toEqual([[], []]);
    expect(mocks.invoke.mock.calls.every(([op]) => op === "native_bridge_context")).toBe(true);
    unmount(); expect(mocks.events.size).toBe(0);
  });
  it("discards stale attachment discovery when the native connection changes mid-request", async () => {
    const { client, handlers, options, context } = setup();
    const oldTopics = deferred<unknown[]>(); client.listTopics.mockReturnValueOnce(oldTopics.promise);
    renderHook(() => useNativePageSession(options));
    await waitFor(() => expect(client.listTopics).toHaveBeenCalledOnce());
    context.epoch++;
    act(() => mocks.events.get("native-session-changed")!({ payload: null }));
    await act(async () => oldTopics.resolve([{ name: "/old", types: [] }]));
    await waitFor(() => expect(client.attach).toHaveBeenCalledTimes(2));
    expect(handlers.connected).toHaveBeenCalledOnce();
    expect(handlers.connected.mock.calls[0][2]).toEqual([]);
  });
  it("unmount during attachment cannot restore connected state or leak event listeners", async () => {
    const { client, handlers, options } = setup(); const pending = deferred<unknown>(); client.attach.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useNativePageSession(options));
    await waitFor(() => expect(client.attach).toHaveBeenCalledOnce());
    unmount(); await act(async () => pending.resolve({}));
    expect(handlers.connected).not.toHaveBeenCalled(); expect(client.listTopics).not.toHaveBeenCalled();
    expect(mocks.events.size).toBe(0); expect(client.close).toHaveBeenCalled();
  });
});

it("uses native visibility for reparented pages even when WebKit reports hidden", () => {
  const snapshot = {selected:"motion" as const, pages:{motion:{detached:true,visible:true,ready:true,busy_reason:""}}};
  expect(pageWindowVisible(false, "motion", snapshot)).toBe(true);
  expect(pageWindowVisible(true, "motion", {...snapshot, pages:{motion:{...snapshot.pages.motion,visible:false}}})).toBe(false);
  expect(pageWindowVisible(true, "monitor", snapshot)).toBe(false);
  expect(pageWindowVisible(false, undefined, snapshot)).toBe(false);
  expect(pageWindowVisible(true, undefined, snapshot)).toBe(true);
});

it("applies retained Motion navigation once and never changes a different robot editor", () => {
  const select = vi.fn(), error = vi.fn();
  const first = {revision:1,tab:"positions" as const,profile_key:"robot"};
  const hook = renderHook(({intent}) => useMotionNavigation("motion", intent, "robot", select, error), {initialProps:{intent:first}});
  expect(select).toHaveBeenCalledExactlyOnceWith("positions");
  hook.rerender({intent:{...first}}); expect(select).toHaveBeenCalledOnce();
  hook.rerender({intent:{...first,revision:2,profile_key:"other"}});
  expect(select).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith(expect.stringContaining("另一连接"));
  hook.rerender({intent:{...first,revision:1}}); expect(select).toHaveBeenCalledOnce();
});
