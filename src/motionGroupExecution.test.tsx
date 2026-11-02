import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEnvelope } from "./types";
import { usePositionMotion } from "./positionMotionLogic";
import type { MotionGroup } from "./motionGroupsLogic";
const group = (): MotionGroup => ({ id: "g1", name: "取放", note: "", preparationDuration: 2,
  steps: [0, 1, 2].map((n) => ({ id: `s${n}`, positionId: `p${n}`, positionName: `姿态${n}`, positionUpdatedAt: 0,
    positions: [0, -.2, -.3, 0, 0, n * .1], duration: n === 0 ? 0 : n === 1 ? 5 : 3, hold: n === 1 ? 2 : 0 })), createdAt: 0, updatedAt: 0 });
function setup(supported = true, captureSupported = false) {
  let listener = (_m: BridgeEnvelope) => {};
  const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => m.op === "position_motion_info"
    ? { op: m.op, available: true, busy: false, motion_group_supported: supported, motion_capture_supported: captureSupported, motion_duration_supported: true }
    : { op: `${m.op}_ack`, accepted: true, command_id: m.command_id });
  const bridge = { request, onMessage: vi.fn((fn: typeof listener) => { listener = fn; return () => {}; }) };
  const hook = renderHook(({ profile, connected, block }) => usePositionMotion(bridge, connected, profile, block),
    { initialProps: { profile: "robot-a", connected: true, block: "" } });
  return { ...hook, request, emit: (m: BridgeEnvelope) => act(() => listener(m)) };
}
describe("Bridge-owned motion groups", () => {
  it("keeps a rejected group attempt identifiable after its execution lock is released", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async message => message.op === "position_group_start"
      ? { op: "position_group_start_ack", accepted: false, message: "控制器反馈已过期" } : original(message));
    await act(async () => h.result.current.executeGroup!(group()));
    expect(h.result.current.state).toMatchObject({ phase: "failed", label: "取放", message: "控制器反馈已过期", group: { id: "g1", index: 0, stepLabel: "姿态0", phase: "preparing" } });
    expect(h.result.current.state.commandId).not.toBe(""); expect(h.result.current.busy).toBe(false);
  });
  it("retains terminal diagnostic errors without using them to override the server outcome", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    await act(async () => h.result.current.executeGroup!(group())); const command_id = h.result.current.state.commandId;
    const errors = [{ joint_name: "joint4", target: 0, actual: -.043679, position_error: -.043679, position_tolerance: .02, velocity: -.007326, velocity_tolerance: .03, unit: "rad" as const }];
    h.emit({ op: "position_motion", command_id, motion_phase: "succeeded", group_id: "g1", group_count: 3, group_index: 2, group_phase: "holding", group_elapsed_s: 10,
      group_step_label: "C（执行时快照）", arrival_errors: errors, position_error_check_enforced: false });
    expect(h.result.current.state.phase).toBe("succeeded"); expect(h.result.current.busy).toBe(false);
    expect(h.result.current.state.group?.stepLabel).toBe("C（执行时快照）");
    expect(h.result.current.state.arrivalErrors).toEqual(errors); expect(h.result.current.state.positionErrorCheckEnforced).toBe(false);
  });
  it("keeps trigger and later stop snapshots separate, clearing absent diagnostics on new events", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe("")); act(() => h.result.current.setArmed(true));
    await act(async () => h.result.current.executeGroup!(group())); const command_id = h.result.current.state.commandId;
    const event: BridgeEnvelope = { op: "position_motion", command_id, motion_phase: "canceling", group_id: "g1", group_count: 3, group_index: 1, group_phase: "holding", group_elapsed_s: 7 };
    const row = { joint_name: "joint3", target: -.84, actual: -.81, position_error: .03, position_tolerance: .02, velocity: .04, velocity_tolerance: .03, unit: "rad" as const };
    const hold_failure = { reason: "position_drift" as const, phase: "holding" as const, captured_at_ms: 100, feedback_age_ms: 2, samples: [row] };
    h.emit({ ...event, hold_failure });
    expect(h.result.current.state.holdFailure?.samples[0].target).toBe(-.84);
    h.emit({ ...event, motion_phase: "verifying" });
    expect(h.result.current.state.holdFailure).toBeUndefined();
    h.emit({ ...event, motion_phase: "failed", hold_failure, arrival_errors: [{ ...row, target: -.967, velocity: 0, position_error: .157 }] });
    expect(h.result.current.state.holdFailure?.samples[0].velocity).toBe(.04);
    expect(h.result.current.state.arrivalErrors?.[0].velocity).toBe(0);
    expect(h.result.current.state.arrivalErrors?.[0].target).toBe(-.967);
    row.target = 99;
    expect(h.result.current.state.holdFailure?.samples[0].target).toBe(-.84);
    expect(h.result.current.busy).toBe(false);
  });
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
  it("requires capture capability and submits Actions in the Bridge-owned group snapshot", async () => {
    const g = group(); g.tracks = [{ id: "arm", kind: "arm", name: "机械臂", deviceId: "current" }, { id: "camera", kind: "camera", name: "相机", deviceId: "current" }];
    g.actions = [{ id: "photo", type: "camera_capture", name: "采集", trackId: "camera", afterStepId: "s0", topic: "/test/image", timeout: 5 }];
    const old = setup(); await waitFor(() => expect(old.result.current.groupReason).toBe("")); act(() => old.result.current.setArmed(true));
    await act(async () => old.result.current.executeGroup!(g));
    expect(old.result.current.state.message).toContain("不支持拍照");
    expect(old.request.mock.calls.some(([m]) => m.op === "position_group_start")).toBe(false); old.unmount();
    const h = setup(true, true); await waitFor(() => expect(h.result.current.captureSupported).toBe(true)); act(() => h.result.current.setArmed(true));
    await act(async () => h.result.current.executeGroup!(g));
    const start = h.request.mock.calls.find(([m]) => m.op === "position_group_start")![0];
    expect(start.steps?.[0].captures).toEqual([{ id: "photo", label: "采集", type: "camera_capture", topic: "/test/image", timeout_s: 5 }]);
    g.actions[0].topic = "/changed"; expect(start.steps?.[0].captures?.[0].topic).toBe("/test/image");
    h.emit({ op: "position_motion", command_id: start.command_id, motion_phase: "waiting", group_id: g.id, group_count: 3, group_index: 0, group_phase: "holding", group_elapsed_s: 1,
      capture_result: { id: "photo", name: "采集", path: "/captures/image.png", image_stamp: 1, joint_stamp: 1, thumbnail: "AQID" } });
    expect(h.result.current.state.capture?.path).toBe("/captures/image.png"); expect(h.result.current.busy).toBe(true);
    h.rerender({ profile: "other", connected: false, block: "" }); expect(h.result.current.state.capture).toBeUndefined();
  });

  it("omits capture fields for empty Action lists to retain old Bridge compatibility", async () => {
    const h = setup(); await waitFor(() => expect(h.result.current.groupReason).toBe(""));
    act(() => h.result.current.setArmed(true)); const g = group(); g.actions = [];
    await act(async () => h.result.current.executeGroup!(g));
    const start = h.request.mock.calls.find(([m]) => m.op === "position_group_start")![0];
    expect(JSON.parse(JSON.stringify(start)).steps.every((s: { captures?: unknown }) => !("captures" in s))).toBe(true);
  });

});
