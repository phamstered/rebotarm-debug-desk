import { describe, expect, it } from "vitest";
import type { RosControlStatus } from "./types";
import {
  DEFAULT_VLA_JOINT_COUNT,
  GRAVITY_COMPENSATION_CONTROLLER,
  VLA_CHUNK_MESSAGE_TYPE,
  VLA_CHUNK_TOPIC,
  VLA_EXCLUSIVE_CONTROLLER_NAMES,
  VLA_POSITION_CONTROLLER,
  createVlaChunkDashboard,
  createVlaChunkSeries,
  isGravityCompensationActive,
  isVlaControllerActive,
  isVlaExclusivePositionController,
  HOLD_ABORT_MESSAGE,
  listVlaStartActivate,
  listVlaStartDeactivate,
  planVlaStartArmStop,
  isHardwareTrack,
  vlaChunkPositionField,
  vlaStartVerificationFailure,
} from "./vlaLogic";

function ros(controllers: RosControlStatus["controllers"]): RosControlStatus {
  return {
    manager: "/controller_manager",
    available: true,
    controllers,
    message: "",
  };
}

describe("vlaLogic", () => {
  it("exports stack PR #15 contract names", () => {
    expect(VLA_POSITION_CONTROLLER).toBe("vla_position_controller");
    expect(VLA_CHUNK_TOPIC).toBe("/vla/joint_chunk");
    expect(VLA_CHUNK_MESSAGE_TYPE).toBe("microros_stm32h723_bridge/msg/VlaJointChunk");
    expect(GRAVITY_COMPENSATION_CONTROLLER).toBe("gravity_compensation_controller");
    expect(VLA_EXCLUSIVE_CONTROLLER_NAMES).toEqual([
      "arm_teleop_controller",
      "arm_trajectory_controller",
    ]);
    expect(DEFAULT_VLA_JOINT_COUNT).toBe(6);
  });

  it("detects exclusive position controllers and ignores gravity/gripper", () => {
    expect(isVlaExclusivePositionController("arm_teleop_controller")).toBe(true);
    expect(isVlaExclusivePositionController("arm_trajectory_controller")).toBe(true);
    expect(isVlaExclusivePositionController("teleop")).toBe(true);
    expect(isVlaExclusivePositionController(GRAVITY_COMPENSATION_CONTROLLER)).toBe(false);
    expect(isVlaExclusivePositionController(VLA_POSITION_CONTROLLER)).toBe(false);
    expect(isVlaExclusivePositionController("gripper_teleop_controller")).toBe(false);
    expect(isVlaExclusivePositionController("joint_state_broadcaster")).toBe(false);
  });

  it("reports VLA / gravity active from rosControl", () => {
    const status = ros([
      { name: VLA_POSITION_CONTROLLER, typeName: "t", state: "active" },
      { name: GRAVITY_COMPENSATION_CONTROLLER, typeName: "t", state: "active" },
      { name: "arm_teleop_controller", typeName: "t", state: "inactive" },
    ]);
    expect(isVlaControllerActive(status)).toBe(true);
    expect(isGravityCompensationActive(status)).toBe(true);
    expect(isVlaControllerActive(ros([{ name: VLA_POSITION_CONTROLLER, typeName: "t", state: "inactive" }]))).toBe(false);
  });

  it("builds activate/deactivate lists for VLA start", () => {
    const status = ros([
      { name: "arm_teleop_controller", typeName: "t", state: "active" },
      { name: "arm_trajectory_controller", typeName: "t", state: "inactive" },
      { name: GRAVITY_COMPENSATION_CONTROLLER, typeName: "t", state: "inactive" },
      { name: VLA_POSITION_CONTROLLER, typeName: "t", state: "inactive" },
    ]);
    expect(listVlaStartActivate(status)).toEqual([
      VLA_POSITION_CONTROLLER,
      GRAVITY_COMPENSATION_CONTROLLER,
    ]);
    expect(listVlaStartDeactivate(status)).toEqual(["arm_teleop_controller"]);

    const gravityOn = ros([
      { name: GRAVITY_COMPENSATION_CONTROLLER, typeName: "t", state: "active" },
      { name: "arm_trajectory_controller", typeName: "t", state: "active" },
    ]);
    expect(listVlaStartActivate(gravityOn)).toEqual([VLA_POSITION_CONTROLLER]);
    expect(listVlaStartDeactivate(gravityOn)).toEqual(["arm_trajectory_controller"]);
  });

  it("creates Monitor series for VlaJointChunk positions[]", () => {
    const series = createVlaChunkSeries();
    expect(series).toHaveLength(6);
    expect(series.map((entry) => entry.fieldPath)).toEqual([
      "positions[0]",
      "positions[1]",
      "positions[2]",
      "positions[3]",
      "positions[4]",
      "positions[5]",
    ]);
    expect(series[0]!.topic).toBe(VLA_CHUNK_TOPIC);
    expect(vlaChunkPositionField(0)).toBe("positions[0]");
    const dashboard = createVlaChunkDashboard();
    expect(dashboard.name).toBe("VLA Joint Chunk");
    expect(dashboard.panels).toHaveLength(6);
  });
  it("plans owns-skip-stop and refuses unknown ownership", () => {
    expect(planVlaStartArmStop(null)).toEqual({ kind: "stop" });
    expect(planVlaStartArmStop({
      mode: "teleop",
      teleopRunning: true,
      trajectoryRunning: false,
      realsenseRunning: false,
      teleopPid: 9,
      trajectoryPid: 0,
      realsensePid: 0,
      teleopOwnsRos2Control: true,
      trajectoryOwnsRos2Control: false,
      message: "",
    }).kind).toBe("skip-stop");
    expect(planVlaStartArmStop({
      mode: "teleop",
      teleopRunning: true,
      trajectoryRunning: false,
      realsenseRunning: false,
      teleopPid: 9,
      trajectoryPid: 0,
      realsensePid: 0,
      teleopOwnsRos2Control: null,
      trajectoryOwnsRos2Control: false,
      message: "",
    })).toMatchObject({ kind: "refuse" });
    expect(planVlaStartArmStop({
      mode: "idle",
      teleopRunning: false,
      trajectoryRunning: false,
      realsenseRunning: false,
      teleopPid: 0,
      trajectoryPid: 0,
      realsensePid: 0,
      teleopOwnsRos2Control: false,
      trajectoryOwnsRos2Control: false,
      message: "",
    })).toEqual({ kind: "stop" });
  });

  it("aborts HOLD copy and verifies VLA start postconditions", () => {
    expect(HOLD_ABORT_MESSAGE).toContain("已中止");
    expect(isHardwareTrack({ mode: 1, mode_name: "TRACK" })).toBe(true);
    expect(isHardwareTrack({ mode: 0, mode_name: "HOLD" })).toBe(false);
    const inactive = ros([{ name: VLA_POSITION_CONTROLLER, typeName: "t", state: "inactive" }]);
    expect(vlaStartVerificationFailure(inactive, null)).toContain("未处于 active");
    const active = ros([{ name: VLA_POSITION_CONTROLLER, typeName: "t", state: "active" }]);
    expect(vlaStartVerificationFailure(active, null)).toBeUndefined();
    expect(vlaStartVerificationFailure(active, { mode: 0, mode_name: "HOLD" })).toContain("TRACK");
    expect(vlaStartVerificationFailure(active, { mode: 1, mode_name: "TRACK" })).toBeUndefined();
  });

});
