import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME } from "./positionLogic";
import type { MotionArrivalError } from "./types";

/** Feedback is a verification snapshot; malformed/absent data never inherits an earlier sample. */
export function parseMotionArrivalErrors(value: unknown): MotionArrivalError[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) return undefined;
  const names = new Set<string>(), result: MotionArrivalError[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const r = row as Record<string, unknown>, name = r.joint_name;
    if (typeof name !== "string" || names.has(name) || !(ARM_JOINT_NAMES.some(joint => joint === name) || name === GRIPPER_JOINT_NAME)) return undefined;
    const unit = name === GRIPPER_JOINT_NAME ? "m" : "rad";
    if (r.unit !== unit) return undefined;
    for (const key of ["target", "actual", "position_error", "position_tolerance", "velocity", "velocity_tolerance"])
      if (typeof r[key] !== "number" || !Number.isFinite(r[key])) return undefined;
    if ((r.position_tolerance as number) < 0 || (r.velocity_tolerance as number) < 0) return undefined;
    names.add(name);
    result.push({ joint_name: name, target: r.target as number, actual: r.actual as number,
      position_error: r.position_error as number, position_tolerance: r.position_tolerance as number,
      velocity: r.velocity as number, velocity_tolerance: r.velocity_tolerance as number, unit });
  }
  return result;
}
