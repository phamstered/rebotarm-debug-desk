import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { captureTeachingPose, teachingControllersReady, useTeachingGripper } from "./teachingLogic";
import { resolveActiveControlMode } from "./statusLogic";
import { defaultProfile, type RosControlStatus } from "./types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const ready: RosControlStatus = { manager: "/controller_manager", available: true, fresh: true, message: "", controllers: ["gravity_compensation_controller", "gripper_trajectory_controller"].map(name => ({ name, state: "active", typeName: "test" })) };

describe("teaching control admission", () => {
  it("requires fresh independent gripper + gravity and excludes position owners", () => {
    expect(teachingControllersReady(ready)).toBe(true);
    expect(teachingControllersReady({ ...ready, fresh: false })).toBe(false);
    expect(teachingControllersReady({ ...ready, controllers: ready.controllers.slice(1) })).toBe(false);
    for (const name of ["arm_teleop_controller", "arm_trajectory_controller", "vla_position_controller", "joint4_calibration_controller", "gripper_teleop_controller"]) {
      expect(teachingControllersReady({ ...ready, controllers: [...ready.controllers, { name, state: "active", typeName: "test" }] })).toBe(false);
    }
    expect(resolveActiveControlMode({ rosControl: ready })).toBe(null);
  });
});

describe("teaching gripper requests", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });
  it("serializes moves and scopes cancellation to the same operation", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((_name, args) => (args as { operation: string }).operation === "move" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, message: "取消已请求" }));
    const { result } = renderHook(() => useTeachingGripper(defaultProfile, true));
    act(() => { void result.current.move(.02); });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(() => result.current.move(.03));
    expect(invoke).toHaveBeenCalledTimes(1);
    await act(() => result.current.cancel());
    const move = vi.mocked(invoke).mock.calls[0][1] as { commandId: string };
    expect(invoke).toHaveBeenLastCalledWith("teaching_gripper_action", expect.objectContaining({ operation: "cancel", commandId: move.commandId }));
    expect(result.current.busy).toBe(true); // cancellation ACK is not completion
    await act(async () => finish({ ok: false, message: "已取消并停稳" }));
    expect(result.current.busy).toBe(false);
    expect(result.current.message).toBe("已取消并停稳");
  });
  it("rejects invalid targets and clears old-session results", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((_name, args) => (args as { operation: string }).operation === "move" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, message: "取消" }));
    const { result, rerender } = renderHook(({ connected }) => useTeachingGripper(defaultProfile, connected), { initialProps: { connected: true } });
    for (const q of [NaN, Infinity, -.001, .051]) await act(() => result.current.move(q));
    expect(invoke).not.toHaveBeenCalled();
    act(() => { void result.current.move(.01); });
    rerender({ connected: false });
    expect(invoke).toHaveBeenCalledWith("teaching_gripper_action", expect.objectContaining({ operation: "cancel" }));
    await act(async () => finish({ ok: true, message: "旧会话成功" }));
    expect(result.current.message).toBe("");
    expect(result.current.busy).toBe(false);
  });
});


it("captures calibrated seven-joint teaching poses without MoveIt and rejects stale/raw data", () => {
  const sample = { data: { name: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "gripper_finger_left_joint"], position: [0, -.2, -.3, .4, .5, .6, .012] }, lastAt: 100, firstAt: 100, count: 1, hz: 20 };
  expect(captureTeachingPose(sample, 200)).toEqual({ positions: [0, -.2, -.3, .4, .5, .6], gripperPosition: .012 });
  expect(captureTeachingPose(sample, 600)).toHaveProperty("error");
  expect(captureTeachingPose({ ...sample, data: { ...sample.data, position: [0, 0, 0, 0, 0, 0, -2.5] } }, 200)).toHaveProperty("error");
  expect(captureTeachingPose({ ...sample, data: { ...sample.data, name: sample.data.name.slice(0, 6) } }, 200)).toHaveProperty("error");
});
