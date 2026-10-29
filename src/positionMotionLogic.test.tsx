import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEnvelope } from "./types";
import { usePositionMotion } from "./positionMotionLogic";
import type { CustomPosition } from "./positionLogic";
const point: CustomPosition = { id: "p1", name: "取料", group: "arm", jointNames: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"], positions: [0, -.2, -.3, 0, 0, 0], source: "manual", note: "", capturedAt: null, createdAt: 0, updatedAt: 0 };
function setup() {
  let listener: (m: BridgeEnvelope) => void = () => {};
  const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => {
    if (m.op === "position_motion_info") return { op: m.op, available: true, home_positions: [0, -.01, -.01, 0, 0, 0], busy: false };
    return { op: `${m.op}_ack`, accepted: true, command_id: m.command_id };
  });
  const bridge = { request, onMessage: vi.fn((fn: typeof listener) => { listener = fn; return () => {}; }) };
  const hook = renderHook(({ connected, profile, block }) => usePositionMotion(bridge, connected, profile, block), { initialProps: { connected: true, profile: "jetson", block: "" } });
  return { ...hook, request, emit: (m: BridgeEnvelope) => act(() => listener(m)) };
}
describe("saved MoveIt motion", () => {
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
