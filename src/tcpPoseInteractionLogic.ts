import { Euler, Quaternion, Vector3 } from "three";
import type { Quat, Vec3 } from "./kinematicsLogic";
export type TcpTargetPose = { position: Vec3; orientation: Quat };
export type TcpHandleFrame = "base" | "tool";
export const TCP_AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
export function poseRpyDegrees(pose: TcpTargetPose): Vec3 {
  const e = new Euler().setFromQuaternion(
    new Quaternion(...pose.orientation),
    "ZYX",
  );
  return [e.x, e.y, e.z].map((v) => (v * 180) / Math.PI) as Vec3;
}
export function poseFromInputs(values: string[]): {
  pose?: TcpTargetPose;
  error: string;
} {
  if (
    values.length !== 6 ||
    values.some((v) => !v.trim() || !Number.isFinite(Number(v)))
  )
    return { error: "XYZ / RPY 必须为有限数值" };
  const q = new Quaternion()
    .setFromEuler(
      new Euler(
        ...(values.slice(3).map((v) => Number(v) * (Math.PI / 180)) as Vec3),
        "ZYX",
      ),
    )
    .normalize();
  return {
    pose: {
      position: values.slice(0, 3).map((v) => Number(v) / 1000) as Vec3,
      orientation: q.toArray() as Quat,
    },
    error: "",
  };
}
/** Axis parameter from the camera-facing plane containing that axis. */
export function axisRayParameter(
  origin: Vector3,
  direction: Vector3,
  point: Vector3,
  axis: Vector3,
  cameraDirection: Vector3,
): number | null {
  const normal = cameraDirection
    .clone()
    .addScaledVector(axis, -cameraDirection.dot(axis));
  if (normal.lengthSq() < 1e-8) return null;
  normal.normalize();
  const denominator = direction.dot(normal);
  if (Math.abs(denominator) < 1e-8) return null;
  const t = point.clone().sub(origin).dot(normal) / denominator;
  if (t < 0) return null;
  return origin.clone().addScaledVector(direction, t).sub(point).dot(axis);
}
export function rayRingVector(
  origin: Vector3,
  direction: Vector3,
  point: Vector3,
  axis: Vector3,
): Vector3 | null {
  const denominator = direction.dot(axis);
  if (Math.abs(denominator) < 1e-8) return null;
  const t = point.clone().sub(origin).dot(axis) / denominator;
  if (t < 0) return null;
  const radial = origin.clone().addScaledVector(direction, t).sub(point);
  return radial.lengthSq() < 1e-10 ? null : radial.normalize();
}
export function moveTcpPose(
  start: TcpTargetPose,
  axisIndex: number,
  frame: TcpHandleFrame,
  amount: number,
  rotation: boolean,
): TcpTargetPose {
  const q = new Quaternion(...start.orientation);
  const axis = new Vector3(...TCP_AXES[axisIndex]);
  if (frame === "tool") axis.applyQuaternion(q);
  if (rotation)
    return {
      position: [...start.position],
      orientation: new Quaternion()
        .setFromAxisAngle(axis, amount)
        .multiply(q)
        .normalize()
        .toArray() as Quat,
    };
  return {
    position: new Vector3(...start.position)
      .addScaledVector(axis, amount)
      .toArray() as Vec3,
    orientation: [...start.orientation],
  };
}
