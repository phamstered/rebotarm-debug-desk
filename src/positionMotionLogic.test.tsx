import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEnvelope } from "./types";
import { usePositionMotion } from "./positionMotionLogic";
import type { CustomPosition } from "./positionLogic";
const point: CustomPosition = { id: "p1", name: "取料", group: "arm", jointNames: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"], positions: [0, -.2, -.3, 0, 0, 0], source: "manual", note: "", capturedAt: null, createdAt: 0, updatedAt: 0 };
function setup() {
  let listener: (m: BridgeEnvelope) => void = () => {};
  const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => {
    if (m.op === "position_motion_info") return { op: m.op, available: true, home_positions: [0, -.01, -.01, 0, 0, 0], busy: false, joint_rotation_supported: true, joint_targets_supported: true, motion_duration_supported: true };
    return { op: `${m.op}_ack`, accepted: true, command_id: m.command_id };
  });
  const bridge = { request, onMessage: vi.fn((fn: typeof listener) => { listener = fn; return () => {}; }) };
  const hook = renderHook(({ connected, profile, block }) => usePositionMotion(bridge, connected, profile, block), { initialProps: { connected: true, profile: "jetson", block: "" } });
  return { ...hook, request, emit: (m: BridgeEnvelope) => act(() => listener(m)) };
}
describe("saved MoveIt motion", () => {
  it("submits six staged joints and duration once, with safety and shared locking", async () => {
    const { result, request, emit } = setup();
    await waitFor(() => expect(result.current.jointTargetsReason).toBe(""));
    const targets = { joint1: .1, joint2: -.2, joint3: -.3, joint4: .2, joint5: .1, joint6: -.1 };
    await act(async () => result.current.executeJoints(targets, 5));
    expect(request.mock.calls.filter(([m]) => m.op === "position_move")).toHaveLength(0);
    act(() => result.current.setArmed(true));
    await act(async () => Promise.all([result.current.executeJoints(targets, 5), result.current.execute(point)]));
    targets.joint1 = 99;
    const moves = request.mock.calls.filter(([m]) => m.op === "position_move");
    expect(moves).toHaveLength(1);
    expect(moves[0][0]).toMatchObject({ joint_targets: { joint1: .1, joint2: -.2, joint3: -.3, joint4: .2, joint5: .1, joint6: -.1 }, motion_duration_s: 5, confirmation: "ARMED" });
    expect(moves[0][0].positions).toBeUndefined();
    expect(moves[0][0].joint_name).toBeUndefined();
    expect(result.current.busy).toBe(true);
    await act(async () => result.current.cancel());
    expect(result.current.busy).toBe(true);
    emit({ op: "position_motion", command_id: moves[0][0].command_id, motion_phase: "canceled" });
    expect(result.current.busy).toBe(false);
  });
  it("rejects invalid joint/time inputs and never drops duration on an old Bridge", async () => {
    const { result, request, rerender } = setup();
    await waitFor(() => expect(result.current.jointTargetsReason).toBe(""));
    act(() => result.current.setArmed(true));
    for (const duration of [NaN, Infinity, 0, .09, 121])
      await act(async () => result.current.executeJoints({ joint1: .1 }, duration));
    for (const targets of [{}, { bad: .1 }, { joint1: NaN }] as Record<string, number>[])
      await act(async () => result.current.executeJoints(targets, 5));
    expect(request.mock.calls.filter(([m]) => m.op === "position_move")).toHaveLength(0);
    request.mockImplementation(async (m) => ({ op: m.op, available: true, joint_rotation_supported: true }));
    rerender({ connected: true, profile: "legacy", block: "" });
    await waitFor(() => expect(result.current.jointTargetsReason).toContain("更新 Bridge"));
    act(() => result.current.setArmed(true));
    await act(async () => result.current.executeJoints({ joint1: .1 }, 5));
    expect(request.mock.calls.filter(([m]) => m.op === "position_move")).toHaveLength(0);
  });

  it("sends an explicit single-joint goal through the same safety, lock and cancellation lifecycle", async () => {
    const { result, request, emit } = setup();
    await waitFor(() => expect(result.current.jointRotationReason).toBe(""));
    await act(async () => result.current.executeJoint("joint2", .3));
    expect(request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
    act(() => result.current.setArmed(true));
    await act(async () => result.current.executeJoint("bad", .3));
    await act(async () => result.current.executeJoint("joint2", NaN));
    expect(request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
    await act(async () => Promise.all([result.current.executeJoint("joint2", .3), result.current.execute(point)]));
    const moves = request.mock.calls.filter(([m]) => m.op === "position_move");
    expect(moves).toHaveLength(1);
    expect(moves[0][0]).toMatchObject({ joint_name: "joint2", joint_position: .3, confirmation: "ARMED", home: false });
    expect(moves[0][0].positions).toBeUndefined();
    expect(result.current.busy).toBe(true);
    await act(async () => result.current.cancel());
    expect(result.current.busy).toBe(true);
    emit({ op: "position_motion", command_id: moves[0][0].command_id, motion_phase: "canceled" });
    expect(result.current.busy).toBe(false);
  });
  it("fails closed when an older Bridge does not advertise joint rotation", async () => {
    const { result, request, rerender } = setup();
    await waitFor(() => expect(result.current.reason).toBe(""));
    request.mockImplementation(async (m) => ({ op: m.op, available: true }));
    rerender({ connected: true, profile: "old-bridge", block: "" });
    await waitFor(() => expect(result.current.jointRotationReason).toContain("更新 Bridge"));
    act(() => result.current.setArmed(true));
    await act(async () => result.current.executeJoint("joint2", .3));
    expect(request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
  });
  it("does not submit either kind of move while another session owns motion", async () => {
    const { result, request, rerender } = setup();
    request.mockImplementation(async (m) => ({ op: m.op, available: true, busy: true, joint_rotation_supported: true }));
    rerender({ connected: true, profile: "external-motion", block: "" });
    await waitFor(() => expect(result.current.busy).toBe(true));
    act(() => result.current.setArmed(true));
    await act(async () => { await result.current.executeJoint("joint2", .3); await result.current.execute(point); });
    expect(request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
  });
  it("requires safety unlock and blocks unavailable trajectory control", async () => {
    const { result, request, rerender } = setup();
    await waitFor(() => expect(result.current.reason).toBe(""));
    await act(async () => result.current.execute(point));
    expect(request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
    expect(result.current.state.message).toContain("安全");
    act(() => result.current.setArmed(true));
    rerender({ connected: true, profile: "jetson", block: "请先激活轨迹控制" });
    await act(async () => result.current.execute(point));
    expect(request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
  });
  it("sends a snapshot once and never treats ACK as arrival", async () => {
    const { result, request, emit } = setup();
    await waitFor(() => expect(result.current.reason).toBe(""));
    act(() => result.current.setArmed(true));
    await act(async () => { await Promise.all([result.current.execute(point), result.current.execute(point)]); });
    const moves = request.mock.calls.filter(([m]) => m.op === "position_move");
    expect(moves).toHaveLength(1);
    expect(moves[0][0]).toMatchObject({ positions: point.positions, confirmation: "ARMED", home: false });
    expect(result.current.busy).toBe(true);
    expect(result.current.state.phase).not.toBe("succeeded");
    const command_id = moves[0][0].command_id;
    emit({ op: "position_motion", command_id: "other", motion_phase: "succeeded" });
    expect(result.current.busy).toBe(true);
    emit({ op: "position_motion", command_id, motion_phase: "executing", label: "取料", message: "执行中" });
    expect(result.current.state.phase).toBe("executing");
    emit({ op: "position_motion", command_id, motion_phase: "succeeded", message: "实际到位" });
    expect(result.current.busy).toBe(false);
    expect(result.current.state.message).toBe("实际到位");
  });
  it("resolves HOME on the server and cancellation ACK does not mean stopped", async () => {
    const { result, request, emit } = setup();
    await waitFor(() => expect(result.current.homePositions).toHaveLength(6));
    act(() => result.current.setArmed(true));
    await act(async () => result.current.execute("home"));
    const move = request.mock.calls.find(([m]) => m.op === "position_move")![0];
    expect(move.home).toBe(true); expect(move.positions).toBeUndefined();
    await act(async () => result.current.cancel());
    expect(result.current.busy).toBe(true);
    expect(result.current.state.phase).toBe("canceling");
    emit({ op: "position_motion", command_id: move.command_id, motion_phase: "canceled", message: "已停稳" });
    expect(result.current.busy).toBe(false);
  });
  it("unlocks an explicit rejection but keeps uncertain acceptance locked", async () => {
    const { result, request } = setup();
    await waitFor(() => expect(result.current.reason).toBe(""));
    act(() => result.current.setArmed(true));
    request.mockImplementation(async (m) => m.op === "position_move" ? { op: "position_move_ack", accepted: false, message: "硬件故障" } : { op: m.op, available: true });
    await act(async () => result.current.execute(point));
    expect(result.current.state).toMatchObject({ phase: "failed", message: "硬件故障" });
    expect(result.current.busy).toBe(false);
    request.mockImplementation(async (m) => {
      if (m.op === "position_move") throw new Error("请求超时");
      return { op: m.op, available: false, busy: true };
    });
    await act(async () => result.current.execute(point));
    expect(result.current.state.phase).toBe("stop_failed");
    expect(result.current.busy).toBe(true);
    expect(request.mock.calls.filter(([m]) => m.op === "position_move")).toHaveLength(2);
  });
  it("clears the unlock and rejects late acknowledgements on a new connection", async () => {
    const { result, request, rerender, emit } = setup();
    await waitFor(() => expect(result.current.reason).toBe(""));
    act(() => result.current.setArmed(true));
    let resolve: (m: BridgeEnvelope) => void = () => {};
    request.mockImplementation(async (m) => m.op === "position_move" ? new Promise((r) => { resolve = r; }) : { op: m.op, available: true });
    let running: Promise<void>;
    act(() => { running = result.current.execute(point); });
    const id = request.mock.calls.find(([m]) => m.op === "position_move")![0].command_id;
    rerender({ connected: true, profile: "other-host", block: "" });
    await act(async () => { resolve({ op: "position_move_ack" }); await running!; });
    emit({ op: "position_motion", command_id: id, motion_phase: "succeeded" });
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.armed).toBe(false);
  });
});
