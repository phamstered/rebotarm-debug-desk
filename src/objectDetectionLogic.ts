import type { ObjectDetectionFrame, ObjectBox } from "./types";
import { urdfToScenePoint, type Vec3 } from "./kinematicsLogic";

/** Invalid detection metadata must never keep a previous frame's boxes alive. */
export function parseObjectDetection(value: unknown): ObjectDetectionFrame {
  const error: ObjectDetectionFrame = { status: "error", message: "物体检测数据无效", frame_seq: 0, items: [] };
  if (!value || typeof value !== "object") return error;
  const data = value as ObjectDetectionFrame;
  if (!["ok", "empty", "no_table", "error"].includes(data.status) ||
      !Number.isSafeInteger(data.frame_seq) || data.frame_seq < 1 ||
      typeof data.message !== "string" || data.message.length > 1024 ||
      !Array.isArray(data.items) || data.items.length > 20 ||
      (data.status !== "ok" && data.items.length !== 0) || (data.status === "ok" && data.items.length === 0)) return error;
  const ids = new Set<number>();
  for (const box of data.items) {
    if (!box || !Number.isSafeInteger(box.id) || box.id < 1 || ids.has(box.id) ||
        !Number.isInteger(box.point_count) || box.point_count < 1 || box.point_count > 30000 ||
        !Array.isArray(box.center) || box.center.length !== 3 || !box.center.every(n => Number.isFinite(n) && Math.abs(n) <= 3) ||
        !Array.isArray(box.size) || box.size.length !== 3 || !box.size.every(n => Number.isFinite(n) && n > 0 && n <= .5)) return error;
    ids.add(box.id);
  }
  return data;
}
export function objectBoxLines(box: ObjectBox): Float32Array {
  const corners: Vec3[] = Array.from({ length: 8 }, (_, i) => urdfToScenePoint(box.center.map((c, a) => c + ((i >> a) & 1 ? 1 : -1) * box.size[a] / 2) as Vec3));
  const vertices: number[] = [];
  for (let i = 0; i < 8; i++) for (let a = 0; a < 3; a++) if (!(i & (1 << a))) vertices.push(...corners[i], ...corners[i | (1 << a)]);
  return new Float32Array(vertices);
}
export function objectLabel(box: ObjectBox, dimensions: boolean): string {
  return `物体 #${box.id}${dimensions ? ` · ${box.size.map(n => (n * 100).toFixed(1)).join(" × ")} cm` : ""}`;
}
