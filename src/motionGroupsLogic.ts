import type { CustomPosition } from "./positionLogic";
export type MotionGroupStep = {
  id: string;
  positionId: string;
  positionName: string;
  positionUpdatedAt: number;
  positions: number[];
  gripperPosition?: number;
  duration: number;
  hold: number;
};
export type MotionGroup = {
  id: string;
  name: string;
  note: string;
  preparationDuration: number;
  steps: MotionGroupStep[];
  createdAt: number;
  updatedAt: number;
};
export type MotionGroupStore = {
  schemaVersion: 1;
  profiles: Record<string, { groups: MotionGroup[] }>;
};
export const MOTION_GROUP_LIMITS = {
  bytes: 4 * 1024 * 1024,
  profiles: 32,
  groups: 100,
  steps: 100,
} as const;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const text = (v: unknown, max: number, empty = false): v is string =>
  typeof v === "string" &&
  new TextEncoder().encode(v).length <= max &&
  (empty || !!v.trim()) &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
export function emptyMotionGroupStore(): MotionGroupStore {
  return { schemaVersion: 1, profiles: {} };
}
export function validateMotionGroup(value: unknown): string {
  if (
    !object(value) ||
    !fields(value, [
      "id",
      "name",
      "note",
      "preparationDuration",
      "steps",
      "createdAt",
      "updatedAt",
    ])
  )
    return "动作组结构无效";
  if (
    !text(value.id, 128) ||
    !text(value.name, 512) ||
    value.name !== value.name.trim()
  )
    return "动作组 ID 或名称无效";
  if (
    typeof value.note !== "string" ||
    value.note.length > 4000 ||
    value.note.includes("\0")
  )
    return "动作组备注无效";
  if (
    !finite(value.createdAt) ||
    value.createdAt < 0 ||
    !finite(value.updatedAt) ||
    value.updatedAt < 0
  )
    return "动作组时间戳无效";
  if (!finite(value.preparationDuration) || value.preparationDuration <= 0)
    return "准备时长必须为正有限数值";
  if (
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > MOTION_GROUP_LIMITS.steps
  )
    return "动作组需要 1–100 个关键帧";
  const ids = new Set<string>();
  let total = value.preparationDuration;
  for (const [index, s] of value.steps.entries()) {
    if (
      !object(s) ||
      !fields(s, [
        "id",
        "positionId",
        "positionName",
        "positionUpdatedAt",
        "positions",
        "gripperPosition",
        "duration",
        "hold",
      ]) ||
      !text(s.id, 128) ||
      !text(s.positionId, 128) ||
      !text(s.positionName, 512) ||
      !finite(s.positionUpdatedAt) ||
      s.positionUpdatedAt < 0
    )
      return "关键帧点位快照无效";
    if (ids.has(s.id)) return "关键帧 ID 重复";
    ids.add(s.id);
    if (
      !Array.isArray(s.positions) ||
      s.positions.length !== 6 ||
      !s.positions.every(finite)
    )
      return "关键帧必须包含六个有限关节值";
    if (
      Object.prototype.hasOwnProperty.call(s, "gripperPosition") &&
      (!finite(s.gripperPosition) || s.gripperPosition < 0)
    )
      return "夹爪目标必须为非负有限数值";
    if (
      !finite(s.duration) ||
      (index === 0 ? s.duration !== 0 : s.duration <= 0)
    )
      return "首帧运动时长必须为 0，后续帧运动时长必须为正有限数值";
    if (!finite(s.hold) || s.hold < 0) return "停留时长必须为非负有限数值";
    total += s.duration + s.hold;
    if (!Number.isFinite(total) || total > 604800)
      return "动作组总时长不能超过 7 天";
  }
  return "";
}
export function parseMotionGroupStore(
  raw: string | null | undefined,
): MotionGroupStore {
  if (raw === null || raw === undefined) return emptyMotionGroupStore();
  if (new TextEncoder().encode(raw).length > MOTION_GROUP_LIMITS.bytes)
    throw new Error("动作组文件超过 4 MiB");
  const root: unknown = JSON.parse(raw);
  if (
    !object(root) ||
    !fields(root, ["schemaVersion", "profiles"]) ||
    root.schemaVersion !== 1 ||
    !object(root.profiles) ||
    Object.keys(root.profiles).length > MOTION_GROUP_LIMITS.profiles
  )
    throw new Error("动作组文件结构或版本无效");
  for (const [key, profile] of Object.entries(root.profiles)) {
    if (
      !text(key, 512) ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      !object(profile) ||
      !fields(profile, ["groups"]) ||
      !Array.isArray(profile.groups) ||
      profile.groups.length > MOTION_GROUP_LIMITS.groups
    )
      throw new Error("动作组连接配置无效");
    const ids = new Set<string>(),
      names = new Set<string>();
    for (const group of profile.groups) {
      const error = validateMotionGroup(group);
      if (error) throw new Error(error);
      const g = group as MotionGroup;
      if (ids.has(g.id) || names.has(g.name))
        throw new Error("动作组 ID 或名称重复");
      ids.add(g.id);
      names.add(g.name);
    }
  }
  return root as MotionGroupStore;
}
export function serializeMotionGroupStore(store: MotionGroupStore): string {
  const text = JSON.stringify(store);
  parseMotionGroupStore(text);
  return text;
}
export function groupTimeline(
  group: MotionGroup,
): {
  step: MotionGroupStep;
  start: number;
  arrival: number;
  departure: number;
}[] {
  const error = validateMotionGroup(group);
  if (error) throw new Error(error);
  let end = 0;
  return group.steps.map((step, i) => {
    const start = end,
      arrival = i === 0 ? 0 : start + step.duration;
    end = arrival + step.hold;
    return { step, start, arrival, departure: end };
  });
}
export function snapshotStep(
  position: CustomPosition,
  id: string,
  duration = 0,
): MotionGroupStep {
  return {
    id,
    positionId: position.id,
    positionName: position.name,
    positionUpdatedAt: position.updatedAt,
    positions: [...position.positions],
    ...(position.gripperPosition === undefined
      ? {}
      : { gripperPosition: position.gripperPosition }),
    duration,
    hold: 0,
  };
}
