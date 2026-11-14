import { emptyPositionStore, parsePositionStore, type CustomPosition, type PositionStore } from "./positionLogic";

export function decodePositionStore(raw: string | null): PositionStore {
  if (raw === null) return emptyPositionStore();
  const input = JSON.parse(raw);
  if (![1, 2].includes(input?.schemaVersion) || !input.profiles || typeof input.profiles !== "object" || Array.isArray(input.profiles)) throw new Error("姿态库格式无效，已保留原文件");
  const parsed = parsePositionStore(raw, "");
  for (const [key, profile] of Object.entries(input.profiles)) {
    const positions = (profile as {positions?: unknown})?.positions;
    if (!Array.isArray(positions) || parsed.profiles[key]?.positions.length !== positions.length) throw new Error("姿态库包含无效记录，已保留原文件");
    const ids = new Set<string>(), names = new Set<string>();
    for (const position of parsed.profiles[key].positions) {
      if (!position.id.trim() || ids.has(position.id) || names.has(position.name)) throw new Error("姿态库 ID 或名称无效或重复，已保留原文件");
      ids.add(position.id); names.add(position.name);
    }
  }
  return {schemaVersion: parsed.schemaVersion, profiles: parsed.profiles};
}
export function positionFingerprint(position: CustomPosition | undefined): string {
  return position ? JSON.stringify(position) : "";
}
export function assertPositionUnchanged(position: CustomPosition | undefined, expected: string) {
  if (positionFingerprint(position) !== expected) throw new Error("该姿态已在其他窗口修改或删除；草稿已保留，请重新载入后检查");
}
