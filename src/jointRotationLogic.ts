import type { KinematicJoint, KinematicModel } from "./kinematicsLogic";

export type JointRotationPreview = Record<string, number>;
export const radiansToDegrees = (value: number) => value * 180 / Math.PI;
export const degreesToRadians = (value: number) => value * Math.PI / 180;

export function rotationalJoints(model: KinematicModel | null): KinematicJoint[] {
  return (model?.joints ?? []).filter((joint) =>
    (joint.type === "revolute" || joint.type === "continuous") && !joint.mimic &&
    joint.axis.every(Number.isFinite) && Math.hypot(...joint.axis) > 1e-9);
}

/** Mesh → URDF visual → link/joint ancestors, nearest independent rotary joint first. */
export function pickedRotationJoint(model: KinematicModel, ancestorNames: string[]): string | null {
  const joints = rotationalJoints(model);
  for (const name of ancestorNames) {
    const found = joints.find((joint) => joint.child === name || joint.name === name);
    if (found) return found.name;
  }
  return null;
}

export function jointFeedback(names: string[] | undefined, positions: number[] | undefined, name: string): number | null {
  if (!names || new Set(names).size !== names.length) return null;
  const value = positions?.[names.indexOf(name)];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function rotationInput(joint: KinematicJoint, text: string): { position?: number; error: string } {
  const degrees = text.trim() ? Number(text) : NaN;
  const position = degreesToRadians(degrees);
  if (!Number.isFinite(position)) return { error: "请输入有效的目标角度" };
  if (joint.type !== "continuous" && (position < joint.lower - 1e-10 || position > joint.upper + 1e-10))
    return { error: "目标角度超过 URDF 关节限位" };
  return { position: joint.type === "continuous" ? position : Math.min(joint.upper, Math.max(joint.lower, position)), error: "" };
}
