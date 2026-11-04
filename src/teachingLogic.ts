import type { RosControlStatus } from "./types";
import type { TopicSample } from "./appLogic";
import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME } from "./positionLogic";
import { controllerStatusFresh } from "./controllersInfoLogic";

export function teachingControllersReady(status: RosControlStatus | null | undefined): boolean {
  if (!controllerStatusFresh(status)) return false;
  const active = status!.controllers.filter((c) => c.state === "active");
  return active.some((c) => c.name === "gravity_compensation_controller") &&
    !active.some((c) => ["arm_teleop_controller", "arm_trajectory_controller", "vla_position_controller", "joint4_calibration_controller", "gripper_teleop_controller", "gripper_trajectory_controller"].includes(c.name));
}

export const TEACHING_FEEDBACK_TOPIC = "/robot_feedback/joint_states";

export function captureTeachingPose(sample: TopicSample | undefined, now: number): { positions: number[]; gripperPosition: number } | { error: string } {
  if (!sample || !Number.isFinite(sample.lastAt) || now < sample.lastAt || now - sample.lastAt >= 500) return { error: "等待新鲜的示教标定反馈" };
  const data = sample.data as { name?: unknown; position?: unknown } | null;
  if (!data || !Array.isArray(data.name) || !Array.isArray(data.position)) return { error: "示教反馈格式无效" };
  const names = data.name, positions = data.position;
  const ordered = [...ARM_JOINT_NAMES, GRIPPER_JOINT_NAME].map(name => positions[names.indexOf(name)]);
  if (new Set(names).size !== names.length || !ordered.every(v => typeof v === "number" && Number.isFinite(v)) || ordered[6] < 0 || ordered[6] > .05) return { error: "示教七轴反馈缺失或夹爪标定值无效" };
  return { positions: ordered.slice(0, 6), gripperPosition: ordered[6] };
}
