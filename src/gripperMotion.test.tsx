import { SavePoseDialog } from "./SavePoseDialog";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { addPosition, emptyPositionStore, GRIPPER_JOINT_NAME, type PositionDraft, parsePositionStore, serializePositionStore } from "./positionLogic";
import { jointDisplayValue, pickedRotationJoint, rotationalJoints, rotationInput } from "./jointRotationLogic";
import { parseKinematics } from "./kinematicsLogic";
import xml from "./testFixtures/rebotarm-kinematics.urdf?raw";
import { usePositionMotion } from "./positionMotionLogic";
import type { BridgeEnvelope } from "./types";
import { PositionPage } from "./PositionPage";
import { findActiveTrajectoryController } from "./trajectoryLogic";

describe("calibrated joint7", () => {
  it("migrates old positions to hold and roundtrips optional metre targets", () => {
    const { store } = addPosition(emptyPositionStore(), "p", { name: "A", positions: [0,0,0,0,0,0], note: "", gripperPosition: .025 }, 1, "a");
    const parsed = parsePositionStore(serializePositionStore(store), "p");
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.profiles.p.positions[0].gripperPosition).toBe(.025);
    const legacy = JSON.parse(serializePositionStore(store)); legacy.schemaVersion = 1;
    delete legacy.profiles.p.positions[0].gripperPosition;
    expect(parsePositionStore(JSON.stringify(legacy), "p").profiles.p.positions[0].gripperPosition).toBeUndefined();
    legacy.profiles.p.positions[0].gripperPosition = "bad";
    expect(parsePositionStore(JSON.stringify(legacy), "p").profiles.p.positions).toEqual([]);
    expect(addPosition(store, "p", { name: "B", positions: [0,0,0,0,0,0], note: "", gripperPosition: NaN }, 1, "b").error).toContain("有限");
  });
  it("uses mm for the independent finger and maps mimic picking to it", () => {
    const model = parseKinematics(xml), finger = rotationalJoints(model).find((joint) => joint.name === GRIPPER_JOINT_NAME)!;
    expect(finger.type).toBe("prismatic");
    expect(rotationInput(finger, "25").position).toBe(.025);
    expect(jointDisplayValue(finger, .025)).toBe(25);
    expect(rotationInput(finger, "100").error).toContain("限位");
    expect(pickedRotationJoint(model, ["mesh", "gripper_finger_right"])).toBe(GRIPPER_JOINT_NAME);
  });
  it("keeps the gripper controller out of arm TCP controller selection", () => {
    expect(findActiveTrajectoryController([{ name: "gripper_trajectory_controller", state: "active", typeName: "joint_trajectory_controller/JointTrajectoryController" }])).toBeNull();
  });
  it("gates old bridges and limits, then transmits independent gripper targets in metres", async () => {
    let supported = false;
    const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => m.op === "position_motion_info" ? {
      op: m.op, available: true, joint_targets_supported: true, motion_duration_supported: true,
      gripper_supported: supported, gripper_available: supported, gripper_feedback_fresh: supported,
      gripper_joint_name: GRIPPER_JOINT_NAME, gripper_lower: 0, gripper_upper: .05, gripper_position: .01,
    } : { op: "position_move_ack", accepted: true });
    const bridge = { request, onMessage: () => () => {} };
    const hook = renderHook(({ profile }) => usePositionMotion(bridge, true, profile, ""), { initialProps: { profile: "p" } });
    await waitFor(() => expect(hook.result.current.jointTargetsReason).toBe(""));
    act(() => hook.result.current.setArmed(true));
    await act(async () => hook.result.current.executeJoints({ [GRIPPER_JOINT_NAME]: .025 }, 5));
    expect(request.mock.calls.filter(([m]) => m.op === "position_move")).toHaveLength(0);
    supported = true; hook.rerender({ profile: "new" });
    await waitFor(() => expect(hook.result.current.gripper?.available).toBe(true));
    act(() => hook.result.current.setArmed(true));
    await act(async () => hook.result.current.executeJoints({ [GRIPPER_JOINT_NAME]: .06 }, 5));
    expect(hook.result.current.state.message).toContain("限位");
    await act(async () => hook.result.current.executeJoints({ [GRIPPER_JOINT_NAME]: .025 }, 5));
    expect(request.mock.calls.filter(([m]) => m.op === "position_move").map(([m]) => m.joint_targets)).toEqual([{ [GRIPPER_JOINT_NAME]: .025 }]);
  });
  it("saves optional mm entry in metres and explains HOME hold", () => {
    const onCreate = vi.fn((_draft: PositionDraft) => "");
    render(<><PositionPage profileKey="p" store={emptyPositionStore()} urdfXml="" onUpdate={() => ""} onDelete={() => {}} />
      <SavePoseDialog initial={{name:"",positions:[0,0,0,0,0,0],source:"feedback",note:""}} urdfXml="" onSave={onCreate} onClose={vi.fn()} /></>);
    expect(screen.getByText("夹爪：保持当前")).toBeVisible();
    fireEvent.change(screen.getByLabelText("点位名称"), { target: { value: "Grip" } });
    fireEvent.click(screen.getByLabelText("保存夹爪目标"));
    fireEvent.change(screen.getByLabelText("夹爪行程 mm"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "保存点位" }));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ gripperPosition: .025 });
  });
  it("expires gripper snapshots locally and cancels expiry across profiles and disconnect", async () => {
    vi.useFakeTimers();
    try {
      let age = 400;
      const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => ({ op: m.op,
        available: true, gripper_supported: true, gripper_available: true, gripper_feedback_fresh: true,
        gripper_feedback_age_ms: age, gripper_joint_name: GRIPPER_JOINT_NAME,
        gripper_lower: 0, gripper_upper: .05, gripper_position: .02 }));
      const bridge = { request, onMessage: () => () => {} };
      const hook = renderHook(({ profile, connected }) => usePositionMotion(bridge, connected, profile, ""), { initialProps: { profile: "old", connected: true } });
      await act(async () => {});
      expect(hook.result.current.gripper?.fresh).toBe(true);
      act(() => vi.advanceTimersByTime(599));
      expect(hook.result.current.gripper?.fresh).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(hook.result.current.gripper?.position).toBeUndefined();
      expect(hook.result.current.gripper?.fresh).toBe(false);
      hook.rerender({ profile: "old-again", connected: true });
      await act(async () => {});
      act(() => vi.advanceTimersByTime(200));
      age = 0; hook.rerender({ profile: "new", connected: true });
      await act(async () => {});
      act(() => vi.advanceTimersByTime(401)); // Old profile's expiry must not clear the new snapshot.
      expect(hook.result.current.gripper?.fresh).toBe(true);
      act(() => vi.advanceTimersByTime(598));
      expect(hook.result.current.gripper?.fresh).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(hook.result.current.gripper).toMatchObject({ fresh: false, available: false, position: undefined });
      hook.rerender({ profile: "new", connected: false });
      act(() => vi.advanceTimersByTime(2000));
      expect(hook.result.current.gripper?.fresh).toBe(false);
      hook.unmount();
    } finally { vi.useRealTimers(); }
  });

  it("streams calibrated gripper positions without polling, rejects bad packets and scopes expiry to the connection", async () => {
    vi.useFakeTimers();
    try {
      let listener: (message: BridgeEnvelope) => void = () => {};
      let stallInfo = false;
      const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> => {
        if (m.op === "subscribe") return { op: "subscribed" };
        if (stallInfo) return new Promise(() => {});
        return { op: m.op, available: true, gripper_supported: true, gripper_available: true, gripper_feedback_fresh: true,
          gripper_joint_name: GRIPPER_JOINT_NAME, gripper_lower: 0, gripper_upper: .05, gripper_position: .005 };
      });
      const bridge = { request, onMessage: (fn: typeof listener) => { listener = fn; return () => {}; } };
      const hook = renderHook(({ profile, connected }) => usePositionMotion(bridge, connected, profile, ""), { initialProps: { profile: "old", connected: true } });
      await act(async () => {});
      expect(request).toHaveBeenCalledWith({ op: "subscribe", topic: "/robot_feedback/joint_states", type: "sensor_msgs/msg/JointState" }, 3000, expect.any(AbortSignal));
      const packet = (position: number, name = [GRIPPER_JOINT_NAME], values = [position]) => ({ op: "topic_message", topic: "/robot_feedback/joint_states", data: { name, position: values } });
      act(() => { vi.advanceTimersByTime(10); listener(packet(.01)); });
      expect(hook.result.current.gripper?.position).toBe(.01);
      act(() => { vi.advanceTimersByTime(10); listener(packet(.02)); });
      expect(hook.result.current.gripper?.position).toBe(.02);
      expect(request.mock.calls.filter(([m]) => m.op === "position_motion_info")).toHaveLength(1);
      act(() => listener(packet(.03, [GRIPPER_JOINT_NAME, GRIPPER_JOINT_NAME], [.03,.03])));
      expect(hook.result.current.gripper?.position).toBe(.005); // Safe snapshot fallback, no ambiguous packet applied.
      for (const position of [NaN, Infinity, -.01, .06]) {
        act(() => listener(packet(position)));
        expect(hook.result.current.gripper?.position).toBe(.005);
      }
      act(() => { vi.advanceTimersByTime(10); listener(packet(.03)); });
      stallInfo = true;
      await act(async () => { vi.advanceTimersByTime(971); });
      expect(hook.result.current.gripper).toMatchObject({ position: .03, fresh: true, available: true }); // Snapshot expiry does not erase newer stream data.
      act(() => vi.advanceTimersByTime(29));
      expect(hook.result.current.gripper).toMatchObject({ position: undefined, fresh: false, available: false });
      const oldListener = listener;
      stallInfo = false; hook.rerender({ profile: "new", connected: true });
      await act(async () => {});
      act(() => oldListener(packet(.04)));
      expect(hook.result.current.gripper?.position).toBe(.005);
      act(() => listener(packet(.035)));
      expect(hook.result.current.gripper?.position).toBe(.035);
      hook.rerender({ profile: "new", connected: false });
      act(() => { oldListener(packet(.04)); vi.advanceTimersByTime(2000); });
      expect(hook.result.current.gripper?.position).toBeUndefined();
      hook.unmount();
    } finally { vi.useRealTimers(); }
  });

});
