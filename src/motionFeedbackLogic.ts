import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME } from "./positionLogic";
import type { MotionArrivalError, MotionHoldFailure } from "./types";

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

/** The trigger snapshot is separate from subsequent cancellation/stop feedback. */
export function parseMotionHoldFailure(value: unknown): MotionHoldFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (!(r.reason === "position_drift" || r.reason === "velocity_timeout") ||
      !(r.phase === "holding" || r.phase === "paused")) return undefined;
  for (const key of ["captured_at_ms", "feedback_age_ms"])
    if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || (r[key] as number) < 0) return undefined;
  for (const key of ["stable_for_ms", "required_stable_ms"])
    if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key]) || (r[key] as number) < 0)) return undefined;
  const samples = parseMotionArrivalErrors(r.samples);
  if (!samples) return undefined;
  return { reason: r.reason, phase: r.phase, capturedAtMs: r.captured_at_ms as number,
    feedbackAgeMs: r.feedback_age_ms as number, samples,
    ...(r.stable_for_ms === undefined ? {} : { stableForMs: r.stable_for_ms as number }),
    ...(r.required_stable_ms === undefined ? {} : { requiredStableMs: r.required_stable_ms as number }) };
}
