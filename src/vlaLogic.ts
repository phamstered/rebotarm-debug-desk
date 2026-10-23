/** Desk-side VLA scheme B — aligned with rebotarm-ros2-stack PR #15 / docs/vla-integration.md.
 *
 * Path: external inference → /vla/joint_chunk (VlaJointChunk) → vla_position_controller
 * (+ parallel gravity_compensation_controller). Desk never writes /stm32/joint_commands for VLA.
 */

import type { ArmModeStatus, ControllerInfo, HardwareStatus, RosControlStatus } from "./types";
import { createSeries } from "./dataGraphLogic";
import {
  createPanelFromSeries,
  newDashboardId,
  newPanelId,
  packPanelLayouts,
  type MonitorDashboard,
} from "./monitorLogic";

/** ros2_control controller (plugin VlaPositionController, position only, joints 1–6). */
export const VLA_POSITION_CONTROLLER = "vla_position_controller";

/** Chunk topic published by external VLA / mock_vla_chunk_publisher.py. */
export const VLA_CHUNK_TOPIC = "/vla/joint_chunk";

/** Optional prompt topic (not required for Status/Monitor). */
export const VLA_PROMPT_TOPIC = "/vla/prompt";

/** Keep active in parallel with VLA (effort); never deactivate for VLA start/stop. */
export const GRAVITY_COMPENSATION_CONTROLLER = "gravity_compensation_controller";

/**
 * Stack message type. Bridge must support runtime decode (or a built-in) to sample Hz /
 * Monitor fields; if subscribe fails, Status still works from controller state alone.
 */
export const VLA_CHUNK_MESSAGE_TYPE = "microros_stm32h723_bridge/msg/VlaJointChunk";

/** Controller claims joint1–6; Monitor series use positions[0..5]. */
export const DEFAULT_VLA_JOINT_COUNT = 6;

export const DEFAULT_VLA_MONITOR_DASHBOARD_NAME = "VLA Joint Chunk";

/** Exact name from arm_controllers.yaml — Teleop position controller. */
export const ARM_TELEOP_CONTROLLER = "arm_teleop_controller";

/** Exact name from arm_controllers.yaml — Trajectory position controller. */
export const ARM_TRAJECTORY_CONTROLLER = "arm_trajectory_controller";

/** Exact names from arm_controllers.yaml — mutually exclusive with VLA on position interfaces. */
export const VLA_EXCLUSIVE_CONTROLLER_NAMES = [
  ARM_TELEOP_CONTROLLER,
  ARM_TRAJECTORY_CONTROLLER,
] as const;

function normalizeControllerName(name: string): string {
  return name.replace(/^\//, "").trim().toLowerCase();
}

export function isVlaPositionController(name: string): boolean {
  return normalizeControllerName(name) === VLA_POSITION_CONTROLLER;
}

export function isGravityCompensationController(name: string): boolean {
  const n = normalizeControllerName(name);
  return n === GRAVITY_COMPENSATION_CONTROLLER || n.includes("gravity_compensation");
}

/** Controllers that must not share arm position interfaces with VLA. */
export function isVlaExclusivePositionController(name: string): boolean {
  const n = normalizeControllerName(name);
  if (!n) return false;
  if (isVlaPositionController(n) || isGravityCompensationController(n)) return false;
  if (n.includes("broadcaster") || n.includes("calibration") || n.includes("gripper")) return false;
  if ((VLA_EXCLUSIVE_CONTROLLER_NAMES as readonly string[]).includes(n)) return true;
  // Heuristic fallback for older naming (teleop / trajectory shorthand).
  if (n === "teleop" || n === "trajectory") return true;
  if (n.includes("arm_teleop") || n.includes("arm_trajectory")) return true;
  return false;
}

export function findController(
  rosControl: RosControlStatus | null | undefined,
  predicate: (controller: ControllerInfo) => boolean,
): ControllerInfo | undefined {
  if (!rosControl?.available) return undefined;
  return rosControl.controllers.find(predicate);
}

export function isVlaControllerActive(rosControl: RosControlStatus | null | undefined): boolean {
  const controller = findController(rosControl, (entry) => isVlaPositionController(entry.name));
  return controller?.state === "active";
}

export function isArmTeleopController(name: string): boolean {
  const n = normalizeControllerName(name);
  return n === ARM_TELEOP_CONTROLLER || n.includes("arm_teleop") || n === "teleop";
}

export function isArmTrajectoryController(name: string): boolean {
  const n = normalizeControllerName(name);
  return n === ARM_TRAJECTORY_CONTROLLER || n.includes("arm_trajectory") || n === "trajectory";
}

export function isArmTeleopControllerActive(rosControl: RosControlStatus | null | undefined): boolean {
  const controller = findController(rosControl, (entry) => isArmTeleopController(entry.name));
  return controller?.state === "active";
}

export function isArmTrajectoryControllerActive(rosControl: RosControlStatus | null | undefined): boolean {
  const controller = findController(rosControl, (entry) => isArmTrajectoryController(entry.name));
  return controller?.state === "active";
}

export function isGravityCompensationActive(rosControl: RosControlStatus | null | undefined): boolean {
  const controller = findController(rosControl, (entry) => isGravityCompensationController(entry.name));
  return controller?.state === "active";
}

/** Active position controllers to deactivate when starting VLA. */
export function listActiveVlaExclusiveControllers(rosControl: RosControlStatus | null | undefined): string[] {
  if (!rosControl?.available) return [];
  return rosControl.controllers
    .filter((controller) => controller.state === "active" && isVlaExclusivePositionController(controller.name))
    .map((controller) => controller.name);
}

/** Controllers to activate on VLA start (VLA + gravity if loaded but inactive). */
export function listVlaStartActivate(rosControl: RosControlStatus | null | undefined): string[] {
  const activate: string[] = [VLA_POSITION_CONTROLLER];
  if (!rosControl?.available) return activate;
  const gravity = findController(rosControl, (entry) => isGravityCompensationController(entry.name));
  // Only activate gravity when loaded and inactive — avoid --strict fail if unloaded.
  if (gravity && gravity.state !== "active") {
    activate.push(gravity.name);
  }
  return [...new Set(activate)];
}

/** Controllers to deactivate on VLA start (active exclusives only). */
export function listVlaStartDeactivate(rosControl: RosControlStatus | null | undefined): string[] {
  return listActiveVlaExclusiveControllers(rosControl).filter(
    (name) => !isVlaPositionController(name) && !isGravityCompensationController(name),
  );
}

/** Field path prefix for VlaJointChunk.positions[]. */
export function vlaChunkPositionField(index: number): string {
  return `positions[${index}]`;
}

export function createVlaChunkSeries(jointCount = DEFAULT_VLA_JOINT_COUNT, topic = VLA_CHUNK_TOPIC) {
  const series = [];
  for (let index = 0; index < jointCount; index += 1) {
    series.push(createSeries(topic, vlaChunkPositionField(index), index));
  }
  return series;
}

/** One-click Monitor dashboard for /vla/joint_chunk VlaJointChunk positions[i]. */
export function createVlaChunkDashboard(
  jointCount = DEFAULT_VLA_JOINT_COUNT,
  topic = VLA_CHUNK_TOPIC,
  id = newDashboardId(),
): MonitorDashboard {
  const seriesList = createVlaChunkSeries(jointCount, topic);
  const ids = seriesList.map(() => newPanelId());
  const layouts = packPanelLayouts(seriesList.length, (index) => ids[index]!);
  return {
    id,
    name: DEFAULT_VLA_MONITOR_DASHBOARD_NAME,
    panels: seriesList.map((series, index) => createPanelFromSeries(series, layouts[index]!, ids[index])),
  };
}

/** Built-in layout preset panel stubs for Monitor. */
export function createVlaChunkLayoutPresetPanels(jointCount = DEFAULT_VLA_JOINT_COUNT, topic = VLA_CHUNK_TOPIC) {
  const seriesList = createVlaChunkSeries(jointCount, topic);
  const ids = seriesList.map((_, index) => `vla-chunk-${index}`);
  const layouts = packPanelLayouts(seriesList.length, (index) => ids[index]!);
  return seriesList.map((series, index) => ({
    id: ids[index]!,
    title: series.fieldPath,
    layout: layouts[index]!,
    series: { topic: series.topic, fieldPath: series.fieldPath, color: series.color },
  }));
}

/** Bridge HOLD failed — abort Teleop/Trajectory/VLA start (fail closed). */
export const HOLD_ABORT_MESSAGE = "HOLD 请求未确认，已中止模式切换";

export type VlaStartArmStopPlan =
  | { kind: "skip-stop"; reason: string }
  | { kind: "stop" }
  | { kind: "refuse"; reason: string };

function ownsWhileRunning(running: boolean, owns: boolean | null | undefined): "owns" | "not-owns" | "unknown" | "idle" {
  if (!running) return "idle";
  if (owns === true) return "owns";
  if (owns === false) return "not-owns";
  return "unknown";
}

/**
 * Decide whether Start VLA may call `start_arm_mode stop`.
 * If Teleop/Trajectory owns ros2_control → skip stop (only switch_controllers).
 * If ownership cannot be determined while a pid is alive → refuse (fail closed).
 * Explicit user Stop Teleop/Trajectory/VLA may still tear down.
 */
export function planVlaStartArmStop(armMode: ArmModeStatus | null | undefined): VlaStartArmStopPlan {
  const teleop = ownsWhileRunning(Boolean(armMode?.teleopRunning), armMode?.teleopOwnsRos2Control);
  const trajectory = ownsWhileRunning(Boolean(armMode?.trajectoryRunning), armMode?.trajectoryOwnsRos2Control);

  if (teleop === "unknown") {
    return {
      kind: "refuse",
      reason: "无法确认 Teleop 是否持有 ros2_control，已拒绝启动 VLA（请先停止 Teleop 或刷新运行态）",
    };
  }
  if (trajectory === "unknown") {
    return {
      kind: "refuse",
      reason: "无法确认 Trajectory 是否持有 ros2_control，已拒绝启动 VLA（请先停止 Trajectory 或刷新运行态）",
    };
  }
  if (teleop === "owns" || trajectory === "owns") {
    const who = teleop === "owns" && trajectory === "owns"
      ? "Teleop/Trajectory"
      : teleop === "owns"
        ? "Teleop"
        : "Trajectory";
    return {
      kind: "skip-stop",
      reason: `${who} 持有 ros2_control，跳过 stop，仅切换控制器`,
    };
  }
  return { kind: "stop" };
}

/** True when firmware reports TRACK (mode 1 / mode_name TRACK). */
export function isHardwareTrack(status: HardwareStatus | null | undefined): boolean {
  if (!status) return false;
  const name = status.mode_name?.trim().toUpperCase();
  if (name === "TRACK") return true;
  if (name) return false;
  return status.mode === 1;
}

/**
 * After switch_controllers success: require vla_position_controller active.
 * If /stm32/status (HardwareStatus) is available in the flow, also require TRACK.
 * Returns a Chinese failure reason, or undefined when checks pass.
 */
export function vlaStartVerificationFailure(
  rosControl: RosControlStatus | null | undefined,
  hardwareStatus: HardwareStatus | null | undefined,
): string | undefined {
  if (!isVlaControllerActive(rosControl)) {
    return "启动校验失败：vla_position_controller 未处于 active";
  }
  if (hardwareStatus == null) {
    // TRACK check skipped when HardwareStatus is not available in this flow.
    return undefined;
  }
  if (!isHardwareTrack(hardwareStatus)) {
    const modeLabel = hardwareStatus.mode_name?.trim()
      || (typeof hardwareStatus.mode === "number" ? `mode ${hardwareStatus.mode}` : "未知");
    return `启动校验失败：固件未进入 TRACK（当前 ${modeLabel}）`;
  }
  return undefined;
}
