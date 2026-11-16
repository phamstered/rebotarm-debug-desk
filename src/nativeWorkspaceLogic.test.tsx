import { useMotionNavigation, pageWindowVisible } from "./nativeWorkspaceLogic";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "./bridge";
import { defaultProfile } from "./types";
import { hostedPageFromSearch, useNativePageSession, useNativeWorkspace, useNativeMainRecovery } from "./nativeWorkspaceLogic";
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
describe("main document session recovery", () => {
  function setup(connected = true) {
    const context = { epoch: 7, profile_revision: 2, connected, profile: {...defaultProfile, host:"retained-host",localPort:19444}, error:null };
    mocks.invoke.mockResolvedValue(context);
    const client = {attach:vi.fn().mockResolvedValue({op:"hello"}),listTopics:vi.fn().mockResolvedValue([]),close:vi.fn()};
    const options = {enabled:true,bridge:client as unknown as BridgeClient,reset:vi.fn(),connected:vi.fn()};
    return {context,client,options};
  }
  it("reattaches an existing session without SSH, starting a session or replaying commands", async () => {
    const {context,client,options}=setup();
    const hook=renderHook(()=>useNativeMainRecovery(options));
    expect(hook.result.current.pending).toBe(true);
    await waitFor(()=>expect(options.connected).toHaveBeenCalledWith(context.profile,{op:"hello"},[]));
    expect(client.attach.mock.calls).toEqual([[]]);
    expect(mocks.invoke.mock.calls.map(([command])=>command)).toEqual(["native_bridge_context","native_bridge_context"]);
    expect(hook.result.current).toMatchObject({pending:false,error:""});
    hook.rerender(); expect(client.attach).toHaveBeenCalledOnce();
  });
  it("leaves a fresh disconnected launch offline and does not replace draft configuration", async () => {
    const {client,options}=setup(false);
    const hook=renderHook(()=>useNativeMainRecovery(options));
    await waitFor(()=>expect(hook.result.current.pending).toBe(false));
    expect(client.attach).not.toHaveBeenCalled();expect(options.reset).not.toHaveBeenCalled();
    expect(options.connected).not.toHaveBeenCalled();
  });
  it.each(["disconnect","epoch","profile"])("rejects %s while topics are pending and retries only a new observation",async change=>{
    const {context,client,options}=setup(); const topics=deferred<[]>();
    client.listTopics.mockReturnValueOnce(topics.promise);
    const hook=renderHook(()=>useNativeMainRecovery(options));
    await waitFor(()=>expect(client.listTopics).toHaveBeenCalledOnce());
    mocks.invoke.mockResolvedValue({...context,...(change==="disconnect"?{connected:false}:change==="epoch"?{epoch:8}:{profile_revision:3})});
    await act(async()=>topics.resolve([]));
    await waitFor(()=>expect(hook.result.current.error).toContain("共享会话已改变"));
    expect(options.connected).not.toHaveBeenCalled(); expect(client.close).toHaveBeenCalledOnce();
    mocks.invoke.mockResolvedValue({...context,connected:false});
    act(()=>hook.result.current.retry());
    await waitFor(()=>expect(hook.result.current).toMatchObject({pending:false,error:""}));
    expect(client.attach).toHaveBeenCalledOnce();
  });
  it("retains a retry error on context failure without disconnecting the native session",async()=>{
    const {client,options}=setup();mocks.invoke.mockRejectedValue(new Error("context unavailable"));
    const hook=renderHook(()=>useNativeMainRecovery(options));
    await waitFor(()=>expect(hook.result.current.error).toContain("context unavailable"));
    expect(client.attach).not.toHaveBeenCalled();expect(client.close).not.toHaveBeenCalled();
  });
  it("cancels an in-flight attach on unmount and ignores its late result",async()=>{
    const {client,options}=setup();const pending=deferred<unknown>();client.attach.mockReturnValue(pending.promise);
    const hook=renderHook(()=>useNativeMainRecovery(options));
    await waitFor(()=>expect(client.attach).toHaveBeenCalledOnce());hook.unmount();
    await act(async()=>pending.resolve({op:"hello"}));
    expect(client.close).toHaveBeenCalledOnce();expect(options.connected).not.toHaveBeenCalled();
    expect(client.listTopics).not.toHaveBeenCalled();
  });
});
describe("native page routing", () => {
  it("only accepts the nine known feature identifiers", () => {
    for (const page of ["status", "dashboard", "motion", "monitor", "collection", "handeye", "motor", "gravity"]) expect(hostedPageFromSearch(`?page=${page}`)).toBe(page);
    expect(hostedPageFromSearch("?page=calibration")).toBeUndefined();
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

  it("applies offline profile revisions without opening a socket and ignores duplicate notifications", async () => {
    const { client, handlers, options, context } = setup();
    context.connected = false;
    const state = {...context, profile_revision:1};
    mocks.invoke.mockResolvedValue(state);
    renderHook(() => useNativePageSession(options));
    await waitFor(() => expect(handlers.profile).toHaveBeenCalledExactlyOnceWith(defaultProfile));
    expect(client.attach).not.toHaveBeenCalled();
    await act(async () => mocks.events.get("native-session-changed")!({payload:null}));
    expect(handlers.profile).toHaveBeenCalledOnce();
    const next = {...state, profile_revision:2, profile:{...defaultProfile,host:"second-robot",rgbdRgbTopic:"/second/color"}};
    mocks.invoke.mockResolvedValue(next);
    await act(async () => mocks.events.get("native-session-changed")!({payload:null}));
    expect(handlers.profile).toHaveBeenLastCalledWith(next.profile);
    expect(handlers.reset).toHaveBeenCalledTimes(2);
    expect(handlers.disconnected).toHaveBeenCalledTimes(2);
    expect(client.attach).not.toHaveBeenCalled();
    expect(client.listTopics).not.toHaveBeenCalled();
  });

  it("discards an older offline context while a later native context notification is pending", async () => {
    const { client, handlers, options, context } = setup();
    const old = deferred<unknown>();
    mocks.invoke.mockReturnValueOnce(old.promise).mockResolvedValue({...context,connected:false,profile_revision:2,profile:{...defaultProfile,host:"new-robot"}});
    renderHook(() => useNativePageSession(options));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    act(() => mocks.events.get("native-session-changed")!({payload:null}));
    await act(async () => old.resolve({...context,connected:false,profile_revision:1}));
    await waitFor(() => expect(handlers.profile).toHaveBeenCalledOnce());
    expect(handlers.profile.mock.calls[0][0].host).toBe("new-robot");
    expect(client.attach).not.toHaveBeenCalled();
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
  const select = vi.fn();
  const first = {revision:1,tab:"positions" as const,profile_key:"robot"};
  const hook = renderHook(({intent, profile}) => useMotionNavigation("motion", intent, profile, select), {initialProps:{intent:first, profile:"robot"}});
  expect(select).toHaveBeenCalledExactlyOnceWith("positions");
  hook.rerender({intent:{...first}, profile:"robot"}); expect(select).toHaveBeenCalledOnce();
  hook.rerender({intent:{...first,revision:2,profile_key:"other"}, profile:"robot"});
  expect(select).toHaveBeenCalledOnce();
  hook.rerender({intent:{...first,revision:1}, profile:"robot"}); expect(select).toHaveBeenCalledOnce();
  hook.rerender({intent:{...first,revision:1}, profile:"other"}); expect(select).toHaveBeenCalledTimes(2);
  hook.rerender({intent:{...first,revision:1}, profile:"robot"}); expect(select).toHaveBeenCalledTimes(2);
});

it("navigates an existing Motion page to Robot View without replaying older editor intents", () => {
  const select=vi.fn();
  const first: import("./nativeWorkspaceLogic").MotionNavigation = {revision:1,tab:"groups",profile_key:"robot"};
  const hook=renderHook(({page,intent}) => useMotionNavigation(page,intent,"robot",select),
    {initialProps:{page:"motion" as "motion"|"handeye",intent:first}});
  expect(select).toHaveBeenLastCalledWith("groups");
  hook.rerender({page:"motion",intent:{...first,revision:2,tab:"robot"}});
  expect(select).toHaveBeenLastCalledWith("robot");expect(select).toHaveBeenCalledTimes(2);
  hook.rerender({page:"motion",intent:first});expect(select).toHaveBeenCalledTimes(2);
  hook.rerender({page:"handeye",intent:{...first,revision:3,tab:"robot"}});
  expect(select).toHaveBeenCalledTimes(2);
});
