import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePositionMotion } from "./positionMotionLogic";
import type { BridgeEnvelope, TcpPose } from "./types";
const pose: TcpPose = {
  frame_id: "base_link",
  tcp_link: "gripper_link",
  position: [0.1, 0.2, 0.3],
  orientation: [0, 0, 0, 1],
};
describe("TCP pose protocol", () => {
  it("requires explicit capability and serializes only the pose target form", async () => {
    let supported = false;
    const request = vi.fn(async (m: BridgeEnvelope): Promise<BridgeEnvelope> =>
      m.op === "position_motion_info"
        ? {
            op: m.op,
            available: true,
            tcp_pose_supported: supported,
            motion_duration_supported: true,
          }
        : { op: "position_move_ack", accepted: true },
    );
    const bridge = { request, onMessage: () => () => {} };
    const hook = renderHook(
      ({ profile }) => usePositionMotion(bridge, true, profile, ""),
      { initialProps: { profile: "old" } },
    );
    await waitFor(() => expect(hook.result.current.reason).toBe(""));
    act(() => hook.result.current.setArmed(true));
    await act(async () => hook.result.current.executeTcpPose!(pose, 5));
    expect(hook.result.current.state.message).toContain("不支持 TCP 位姿");
    expect(
      request.mock.calls.filter(([m]) => m.op === "position_move"),
    ).toHaveLength(0);
    supported = true;
    hook.rerender({ profile: "new" });
    await waitFor(() => expect(hook.result.current.tcpPoseReason).toBe(""));
    act(() => hook.result.current.setArmed(true));
    await act(async () =>
      hook.result.current.executeTcpPose!(
        { ...pose, orientation: [0, 0, 0, 0] },
        5,
      ),
    );
    expect(hook.result.current.state.message).toContain("无效");
    await act(async () => hook.result.current.executeTcpPose!(pose, 5));
    const moves = request.mock.calls.filter(([m]) => m.op === "position_move");
    expect(moves).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify(moves[0][0]));
    expect(wire).toMatchObject({
      tcp_pose: pose,
      motion_duration_s: 5,
      confirmation: "ARMED",
    });
    for (const key of [
      "positions",
      "home",
      "joint_targets",
      "joint_name",
      "joint_position",
    ])
      expect(wire).not.toHaveProperty(key);
  });
});
