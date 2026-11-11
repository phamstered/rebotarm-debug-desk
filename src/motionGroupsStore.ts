import { parseMotionGroupStore, type MotionGroup } from "./motionGroupsLogic";
export function decodeMotionGroupStore(raw: string | null) {
  return parseMotionGroupStore(raw ?? '{"schemaVersion":1,"profiles":{}}');
}
export function assertMotionGroupUnchanged(group: MotionGroup | undefined, expected: string) {
  if ((group ? JSON.stringify(group) : "") !== expected) throw new Error("该动作组已在其他窗口修改或删除；草稿已保留，请重新载入后检查");
}
