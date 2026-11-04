import { describe, expect, it } from "vitest";
import { captureTeachingPose, teachingControllersReady } from "./teachingLogic";
import { resolveActiveControlMode } from "./statusLogic";
import { type RosControlStatus } from "./types";
const ready: RosControlStatus = { manager: "/controller_manager", available: true, fresh: true, message: "", controllers: ["gravity_compensation_controller"].map(name => ({ name, state: "active", typeName: "test" })) };

describe("teaching control admission", () => {
  it("requires fresh gravity and excludes arm and gripper motion owners", () => {
    expect(teachingControllersReady(ready)).toBe(true);
    expect(teachingControllersReady({ ...ready, fresh: false })).toBe(false);
    expect(teachingControllersReady({ ...ready, controllers: ready.controllers.slice(1) })).toBe(false);
    for (const name of ["arm_teleop_controller", "arm_trajectory_controller", "vla_position_controller", "joint4_calibration_controller", "gripper_teleop_controller", "gripper_trajectory_controller"]) {
      expect(teachingControllersReady({ ...ready, controllers: [...ready.controllers, { name, state: "active", typeName: "test" }] })).toBe(false);
    }
    expect(resolveActiveControlMode({ rosControl: ready })).toBe(null);
  });
});

it("captures calibrated seven-joint teaching poses without MoveIt and rejects stale/raw data", () => {
  const sample = { data: { name: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "gripper_finger_left_joint"], position: [0, -.2, -.3, .4, .5, .6, .012] }, lastAt: 100, firstAt: 100, count: 1, hz: 20 };
  expect(captureTeachingPose(sample, 200)).toEqual({ positions: [0, -.2, -.3, .4, .5, .6], gripperPosition: .012 });
  expect(captureTeachingPose(sample, 600)).toHaveProperty("error");
  expect(captureTeachingPose({ ...sample, data: { ...sample.data, position: [0, 0, 0, 0, 0, 0, -2.5] } }, 200)).toHaveProperty("error");
  expect(captureTeachingPose({ ...sample, data: { ...sample.data, name: sample.data.name.slice(0, 6) } }, 200)).toHaveProperty("error");
});
