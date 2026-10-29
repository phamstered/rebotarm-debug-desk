export const HOME_POSITION_ID = "builtin:home";
export const ARM_JOINT_NAMES = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"] as const;
export const JOINT_FEEDBACK_FRESH_MS = 1000;

export type PositionSource = "manual" | "feedback";

export type CustomPosition = {
  id: string;
  name: string;
  group: "arm";
  jointNames: string[];
  positions: number[];
  source: PositionSource;
  note: string;
  capturedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PositionDraft = {
  name: string;
  positions: number[];
  note: string;
  source?: PositionSource;
};

export type PositionStore = {
  schemaVersion: 1;
  profiles: Record<string, { positions: CustomPosition[] }>;
};

export type HomeRow = {
  id: typeof HOME_POSITION_ID;
  name: "HOME";
  locked: true;
  sync: "pending";
};

export type ParsedPositionStore = PositionStore & { home: HomeRow };

const HOME_ROW: HomeRow = { id: HOME_POSITION_ID, name: "HOME", locked: true, sync: "pending" };

export function profileKeyFor(profile: { host: string; username: string; sshPort: number }) {
  return `${profile.host}|${profile.username}|${profile.sshPort}`;
}

export function emptyPositionStore(): PositionStore {
  return { schemaVersion: 1, profiles: {} };
}

export function homeRow(): HomeRow {
  return HOME_ROW;
}

function finiteJoints(values: number[]) {
  return values.length === ARM_JOINT_NAMES.length && values.every((value) => Number.isFinite(value));
}

function normalizeCustom(value: unknown): CustomPosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<CustomPosition>;
  if (record.id === HOME_POSITION_ID || record.name === "HOME") return null;
  if (typeof record.id !== "string" || typeof record.name !== "string") return null;
  if (!Array.isArray(record.positions) || !finiteJoints(record.positions)) return null;
  const name = record.name.trim();
  if (!name || name === "HOME") return null;
  return {
    id: record.id,
    name,
    group: "arm",
    jointNames: [...ARM_JOINT_NAMES],
    positions: record.positions.map((item) => Number(item)),
    source: record.source === "feedback" ? "feedback" : "manual",
    note: typeof record.note === "string" ? record.note : "",
    capturedAt: typeof record.capturedAt === "number" ? record.capturedAt : null,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

export function parsePositionStore(raw: string | null | undefined, _profileKey: string): ParsedPositionStore {
  const empty = { ...emptyPositionStore(), home: HOME_ROW };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<PositionStore>;
    if (parsed.schemaVersion !== 1 || !parsed.profiles || typeof parsed.profiles !== "object") return empty;
    const profiles: PositionStore["profiles"] = {};
    for (const [key, profile] of Object.entries(parsed.profiles)) {
      const positions = Array.isArray(profile?.positions) ? profile.positions.map(normalizeCustom).filter((item): item is CustomPosition => item !== null) : [];
      profiles[key] = { positions };
    }
    return { schemaVersion: 1, profiles, home: HOME_ROW };
  } catch {
    return empty;
  }
}

export function serializePositionStore(store: PositionStore) {
  return JSON.stringify({ schemaVersion: 1, profiles: store.profiles });
}

function draftError(draft: PositionDraft, positions: CustomPosition[], ignoreId?: string) {
  const name = draft.name.trim();
  if (!name) return "点位名称不能为空";
  if (name === "HOME") return "HOME 是保留名称";
  if (positions.some((item) => item.id !== ignoreId && item.name === name)) return "点位名称重复";
  if (!finiteJoints(draft.positions)) return "六个关节都必须是有限数值";
  return "";
}

function withProfile(store: PositionStore, profileKey: string, positions: CustomPosition[]): PositionStore {
  return { ...store, profiles: { ...store.profiles, [profileKey]: { positions } } };
}

export function addPosition(store: PositionStore, profileKey: string, draft: PositionDraft, now: number, id: string) {
  const positions = store.profiles[profileKey]?.positions ?? [];
  const error = draftError(draft, positions);
  if (error || id === HOME_POSITION_ID) return { store, error: error || "HOME 不能保存为自定义点" };
  const next: CustomPosition = {
    id,
    name: draft.name.trim(),
    group: "arm",
    jointNames: [...ARM_JOINT_NAMES],
    positions: [...draft.positions],
    source: draft.source === "feedback" ? "feedback" : "manual",
    note: draft.note,
    capturedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return { store: withProfile(store, profileKey, [...positions, next]), error: "" };
}

export function updatePosition(store: PositionStore, profileKey: string, id: string, draft: PositionDraft, now: number) {
  if (id === HOME_POSITION_ID) return { store, error: "HOME 不能修改" };
  const positions = store.profiles[profileKey]?.positions ?? [];
  const error = draftError(draft, positions, id);
  if (error) return { store, error };
  return {
    store: withProfile(store, profileKey, positions.map((item) => item.id === id ? {
      ...item,
      name: draft.name.trim(),
      positions: [...draft.positions],
      note: draft.note,
      updatedAt: now,
    } : item)),
    error: "",
  };
}

export function deletePosition(store: PositionStore, profileKey: string, id: string) {
  if (id === HOME_POSITION_ID) return { store, error: "HOME 不能删除" };
  const positions = store.profiles[profileKey]?.positions ?? [];
  return { store: withProfile(store, profileKey, positions.filter((item) => item.id !== id)), error: "" };
}

export function nextCapturedPoseName(existing: Array<{ name: string }>) {
  const names = new Set(existing.map((item) => item.name));
  let index = 1;
  let name = `姿态 ${index}`;
  while (!name.trim() || name === "HOME" || names.has(name)) {
    index += 1;
    name = `姿态 ${index}`;
  }
  return name;
}

export function captureCurrentArmPose(
  samples: Array<{ topic: string; state: { name?: string[]; position?: number[] } | null; receivedAt: number | null }>,
  now: number,
  preferredTopic?: string,
): { positions: number[]; topic: string } | { error: string } {
  const ranked = samples.map((sample) => ({
    topic: sample.topic,
    receivedAt: sample.receivedAt,
    result: captureArmJoints(sample.state, { receivedAt: sample.receivedAt, now }),
  }));
  const ready = ranked.filter((sample) => "positions" in sample.result);
  const preferred = ready.find((sample) => sample.topic === preferredTopic);
  const chosen = preferred ?? [...ready].sort((left, right) => (right.receivedAt ?? 0) - (left.receivedAt ?? 0))[0];
  if (chosen && "positions" in chosen.result) return { positions: chosen.result.positions, topic: chosen.topic };
  const preferredError = ranked.find((sample) => sample.topic === preferredTopic && "error" in sample.result);
  if (preferredError && "error" in preferredError.result) return { error: preferredError.result.error };
  const anyError = ranked.find((sample) => "error" in sample.result);
  return { error: anyError && "error" in anyError.result ? anyError.result.error : "没有新鲜的关节反馈" };
}

export function captureArmJoints(
  jointState: { name?: string[]; position?: number[] } | null,
  timing: { receivedAt: number | null; now: number; maxAgeMs?: number },
): { positions: number[] } | { error: string } {
  if (!jointState || timing.receivedAt === null) return { error: "没有新鲜的关节反馈" };
  if (timing.now - timing.receivedAt > (timing.maxAgeMs ?? JOINT_FEEDBACK_FRESH_MS)) return { error: "关节反馈已过期" };
  const names = jointState.name ?? [];
  const values = jointState.position ?? [];
  const positions = ARM_JOINT_NAMES.map((name) => {
    const index = names.indexOf(name);
    return index >= 0 ? values[index] : Number.NaN;
  });
  if (!finiteJoints(positions)) return { error: "关节反馈不完整" };
  return { positions };
}
