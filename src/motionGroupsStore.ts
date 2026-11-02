import { invoke } from "@tauri-apps/api/core";
import {
  parseMotionGroupStore,
  serializeMotionGroupStore,
  type MotionGroupStore,
} from "./motionGroupsLogic";
let queue: Promise<unknown> = Promise.resolve();
export async function loadStoredMotionGroups(): Promise<MotionGroupStore> {
  return parseMotionGroupStore(await invoke<string>("motion_groups_load"));
}
export function updateStoredMotionGroups(
  update: (store: MotionGroupStore) => MotionGroupStore,
): Promise<MotionGroupStore> {
  const pending = queue
    .catch(() => {})
    .then(async () => {
      const next = update(await loadStoredMotionGroups());
      const content = serializeMotionGroupStore(next);
      await invoke("motion_groups_save", { content });
      return parseMotionGroupStore(content);
    });
  queue = pending;
  return pending;
}
