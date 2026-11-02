import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEnvelope } from "./types";
import { usePositionMotion } from "./positionMotionLogic";
import type { MotionGroup } from "./motionGroupsLogic";
const group = (): MotionGroup => ({ id: "g1", name: "取放", note: "", preparationDuration: 2,
  steps: [0, 1, 2].map((n) => ({ id: `s${n}`, positionId: `p${n}`, positionName: `姿态${n}`, positionUpdatedAt: 0,
    positions: [0, -.2, -.3, 0, 0, n * .1], duration: n === 0 ? 0 : n === 1 ? 5 : 3, hold: n === 1 ? 2 : 0 })), createdAt: 0, updatedAt: 0 });
function setup(supported = true) {
  let listener = (_m: BridgeEnvelope) => {};
  const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => m.op === "position_motion_info"
    ? { op: m.op, available: true, busy: false, motion_group_supported: supported, motion_duration_supported: true }
    : { op: `${m.op}_ack`, accepted: true, command_id: m.command_id });
  const bridge = { request, onMessage: vi.fn((fn: typeof listener) => { listener = fn; return () => {}; }) };
  const hook = renderHook(({ profile, connected, block }) => usePositionMotion(bridge, connected, profile, block),
    { initialProps: { profile: "robot-a", connected: true, block: "" } });
  return { ...hook, request, emit: (m: BridgeEnvelope) => act(() => listener(m)) };
}
describe("Bridge-owned motion groups", () => {
  it("ignores malformed group terminal events and late events after actual completion", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe(""));
    act(() => h.result.current.setArmed(true)); await act(async () => h.result.current.executeGroup!(group()));
    const command_id = h.result.current.state.commandId;
    const event: BridgeEnvelope = { op: "position_motion", command_id, motion_phase: "succeeded", group_id: "g1", group_count: 3, group_index: 2, group_phase: "holding", group_elapsed_s: 10 };
    h.emit({ ...event, group_id: "wrong" }); expect(h.result.current.busy).toBe(true);
    h.emit({ ...event, group_count: undefined }); expect(h.result.current.busy).toBe(true);
    h.emit({ ...event, group_index: -1 }); expect(h.result.current.busy).toBe(true);
    h.emit({ ...event, group_elapsed_s: NaN }); expect(h.result.current.busy).toBe(true);
    h.emit(event); expect(h.result.current.state.phase).toBe("succeeded"); expect(h.result.current.busy).toBe(false);
    h.emit({ ...event, motion_phase: "executing" }); expect(h.result.current.state.phase).toBe("succeeded");
  });
  it("rejects malformed group objects before cloning or sending any motion", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    for (const malformed of [null, {}, { ...group(), steps: null }, { ...group(), steps: [] }]) {
      await act(async () => h.result.current.executeGroup!(malformed as MotionGroup));
      expect(h.result.current.state.phase).toBe("failed");
    }
    expect(h.request.mock.calls.some(([m]) => m.op === "position_group_start" || m.op === "position_move")).toBe(false);
  });
  it("gates resume and deduplicates in-flight group operations while retaining the lock", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    await act(async () => h.result.current.executeGroup!(group())); const command_id = h.result.current.state.commandId;
    h.emit({ op: "position_motion", command_id, motion_phase: "paused", group_id: "g1", group_count: 3, group_index: 0, group_phase: "paused", group_elapsed_s: 0 });
    act(() => h.result.current.setArmed(false)); await act(async () => h.result.current.resumeGroup!());
    expect(h.request.mock.calls.some(([m]) => m.op === "position_group_resume")).toBe(false);
    act(() => h.result.current.setArmed(true)); h.rerender({ profile: "robot-a", connected: true, block: "控制模式切换中" });
    await act(async () => h.result.current.resumeGroup!()); expect(h.request.mock.calls.some(([m]) => m.op === "position_group_resume")).toBe(false);
    h.rerender({ profile: "robot-a", connected: true, block: "" });
    let reject!: (error: Error) => void;
    h.request.mockImplementation(async (m) => m.op === "position_group_resume" ? new Promise((_resolve, fail) => { reject = fail; }) : { op: m.op, available: true, busy: true });
    let pending!: Promise<void>;
    act(() => { pending = h.result.current.resumeGroup!(); void h.result.current.resumeGroup!(); });
    expect(h.request.mock.calls.filter(([m]) => m.op === "position_group_resume")).toHaveLength(1); expect(h.result.current.groupActionBusy).toBe(true);
    await act(async () => { reject(Error("timeout")); await pending; });
    expect(h.result.current.busy).toBe(true); expect(h.result.current.state.phase).toBe("paused"); expect(h.result.current.groupActionBusy).toBe(false);
  });
  it("submits one immutable group, keeps the lock through holds/pause and cancels with the same owner id", async () => {
    const { result, request, emit } = setup(); await waitFor(() => expect(result.current.groupReason).toBe(""));
    const edit = group();
    await act(async () => result.current.executeGroup!(edit));
    expect(request.mock.calls.filter(([m]) => m.op === "position_group_start")).toHaveLength(0);
    act(() => result.current.setArmed(true));
    await act(async () => Promise.all([result.current.executeGroup!(edit), result.current.executeGroup!(edit)]));
    edit.steps[1].positions[0] = 99; edit.steps[1].duration = 99;
    const starts = request.mock.calls.filter(([m]) => m.op === "position_group_start"); expect(starts).toHaveLength(1);
    const start = starts[0][0]; expect(start).toMatchObject({ confirmation: "ARMED", group_id: "g1", preparation_duration_s: 2,
      steps: [{ motion_duration_s: 0 }, { motion_duration_s: 5, hold_duration_s: 2, positions: [0, -.2, -.3, 0, 0, .1] }, { motion_duration_s: 3 }] });
    expect(result.current.busy).toBe(true); expect(result.current.state.group?.phase).toBe("preparing");
    const event = { op: "position_motion", command_id: start.command_id, group_id: "g1", group_count: 3, group_index: 1, group_phase: "holding" as const, group_elapsed_s: 6.2 };
    emit({ ...event, motion_phase: "waiting" }); expect(result.current.state.group?.index).toBe(1); expect(result.current.busy).toBe(true);
    await act(async () => result.current.pauseGroup!());
    expect(result.current.state.phase).toBe("waiting"); // ACK only requests a pause.
    emit({ ...event, motion_phase: "paused", group_phase: "paused" }); expect(result.current.busy).toBe(true);
    await act(async () => result.current.resumeGroup!()); expect(result.current.state.phase).toBe("paused");
    await act(async () => result.current.cancel()); expect(result.current.busy).toBe(true);
    expect(request).toHaveBeenCalledWith({ op: "position_cancel", command_id: start.command_id }, 5000);
    emit({ ...event, motion_phase: "canceled" }); expect(result.current.busy).toBe(false);
    expect(request.mock.calls.filter(([m]) => m.op === "position_move")).toHaveLength(0);
  });
  it("rejects old capabilities, malformed steps, future gripper targets and current external blocks", async () => {
    const old = setup(false); await waitFor(() => expect(old.result.current.groupReason).toContain("不支持动作组"));
    act(() => old.result.current.setArmed(true)); await act(async () => old.result.current.executeGroup!(group()));
    expect(old.request.mock.calls.some(([m]) => m.op === "position_group_start")).toBe(false); old.unmount();
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    for (const modify of [(g: MotionGroup) => { g.steps[1].duration = 0; }, (g: MotionGroup) => { g.steps[2].positions[0] = NaN; }, (g: MotionGroup) => { g.steps[2].gripperPosition = .02; }]) {
      const g = group(); modify(g); await act(async () => h.result.current.executeGroup!(g));
    }
    expect(h.request.mock.calls.some(([m]) => m.op === "position_group_start")).toBe(false);
    h.rerender({ profile: "robot-a", connected: true, block: "控制器切换中" });
    await act(async () => h.result.current.executeGroup!(group())); expect(h.result.current.state.message).toBe("控制器切换中");
  });
  it("holds an uncertain start and never carries a group across connection generations", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    h.request.mockImplementation(async (m) => { if (m.op === "position_group_start") throw Error("timeout"); return { op: m.op, available: true, busy: true, command_id: m.command_id }; });
    await act(async () => h.result.current.executeGroup!(group())); expect(h.result.current.state.phase).toBe("stop_failed"); expect(h.result.current.busy).toBe(true);
    const id = h.result.current.state.commandId; h.rerender({ profile: "robot-b", connected: false, block: "" });
    h.emit({ op: "position_motion", command_id: id, motion_phase: "executing", group_id: "g1" });
    expect(h.result.current.state.phase).toBe("idle"); expect(h.result.current.state.group).toBeUndefined(); expect(h.result.current.armed).toBe(false);
  });
});
