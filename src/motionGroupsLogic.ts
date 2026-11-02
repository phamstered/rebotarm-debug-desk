import {
  ARM_JOINT_NAMES,
  GRIPPER_JOINT_NAME,
  type CustomPosition,
} from "./positionLogic";
export function motionPoseThumbnailProps(
  positions?: number[],
  gripperPosition?: number,
) {
  return {
    jointNames: [
      ...ARM_JOINT_NAMES,
      ...(gripperPosition === undefined ? [] : [GRIPPER_JOINT_NAME]),
    ],
    positions: positions
      ? [
          ...positions,
          ...(gripperPosition === undefined ? [] : [gripperPosition]),
        ]
      : undefined,
  };
}
export type MotionTrack = {
  id: string;
  name: string;
  kind: "arm" | "camera";
  deviceId: string;
};
export type MotionCaptureAction = {
  id: string;
  type: "camera_capture";
  name: string;
  trackId: string;
  afterStepId: string;
  topic: string;
  timeout: number;
};
export const DEFAULT_ARM_TRACK: MotionTrack = {
  id: "arm",
  name: "机械臂",
  kind: "arm",
  deviceId: "current",
};
export const groupTracks = (group: MotionGroup): MotionTrack[] =>
  group.tracks ?? [DEFAULT_ARM_TRACK];
export const stepActions = (group: MotionGroup, stepId: string) =>
  (group.actions ?? []).filter((a) => a.afterStepId === stepId);
export function groupDeviceReason(group: MotionGroup): string {
  if (
    groupTracks(group).some(
      (t) =>
        t.kind === "camera" &&
        t.deviceId !== "current" &&
        group.actions?.some((a) => a.trackId === t.id),
    )
  )
    return "相机轨道必须绑定当前 Bridge 连接";
  const arms = groupTracks(group).filter((t) => t.kind === "arm");
  return arms.length !== 1 || arms[0].deviceId !== "current"
    ? "当前 Bridge 仅支持当前连接的单机械臂执行；多臂轨道可编排，协同执行尚未就绪"
    : "";
}
export type MotionGroupStep = {
  trackId?: string;
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
  tracks?: MotionTrack[];
  actions?: MotionCaptureAction[];
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
      "tracks",
      "actions",
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
  const trackIds = new Map<string, string>();
  const tracks =
    value.tracks === undefined ? [DEFAULT_ARM_TRACK] : value.tracks;
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > 16)
    return "轨道数量须在 1–16";
  for (const t of tracks) {
    if (
      !object(t) ||
      !fields(t, ["id", "name", "kind", "deviceId"]) ||
      !text(t.id, 128) ||
      !text(t.name, 512) ||
      !text(t.deviceId, 512) ||
      !["arm", "camera"].includes(String(t.kind)) ||
      trackIds.has(t.id)
    )
      return "设备轨道无效或重复";
    trackIds.set(t.id, String(t.kind));
  }
  if (![...trackIds.values()].includes("arm")) return "至少需要一个机械臂轨道";
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
        "trackId",
      ]) ||
      !text(s.id, 128) ||
      !text(s.positionId, 128) ||
      !text(s.positionName, 512) ||
      !finite(s.positionUpdatedAt) ||
      s.positionUpdatedAt < 0
    )
      return "关键帧点位快照无效";
    if (trackIds.get(String(s.trackId ?? DEFAULT_ARM_TRACK.id)) !== "arm")
      return "Pose 必须归属有效机械臂轨道";
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
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.length > 100)
      return "Action 数量不能超过 100";
    for (const a of value.actions) {
      if (
        !object(a) ||
        !fields(a, [
          "id",
          "type",
          "name",
          "trackId",
          "afterStepId",
          "topic",
          "timeout",
        ]) ||
        !text(a.id, 128) ||
        !/^[A-Za-z0-9_-]+$/.test(a.id) ||
        !text(a.name, 512) ||
        a.type !== "camera_capture" ||
        ids.has(a.id) ||
        !text(a.afterStepId, 128) ||
        !value.steps.some((s) => (s as MotionGroupStep).id === a.afterStepId) ||
        trackIds.get(String(a.trackId)) !== "camera" ||
        !text(a.topic, 256) ||
        !/^\/(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z_][A-Za-z0-9_]*$/.test(
          a.topic,
        ) ||
        !finite(a.timeout) ||
        a.timeout < 0.1 ||
        a.timeout > 60
      )
        return "拍照 Action 类型、设备、依赖、Topic 或超时无效";
      ids.add(a.id);
      total += a.timeout;
    }
    if (total > 604800) return "动作组总时长不能超过 7 天";
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
export function groupTimeline(group: MotionGroup): {
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
    end =
      arrival +
      step.hold +
      stepActions(group, step.id).reduce((n, a) => n + a.timeout, 0);
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
