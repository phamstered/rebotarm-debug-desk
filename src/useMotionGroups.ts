import { useRef } from "react";
import { serializeMotionGroupStore, type MotionGroup, validateMotionGroup } from "./motionGroupsLogic";
import { assertMotionGroupUnchanged, decodeMotionGroupStore } from "./motionGroupsStore";
import { useVersionedStore } from "./useVersionedStore";

export function useMotionGroups(profileKey: string, enabled = true) {
  const shared = useVersionedStore("motion_groups", decodeMotionGroupStore, enabled);
  const currentProfile = useRef(profileKey); currentProfile.current = profileKey;
  async function change(update: (groups: MotionGroup[]) => MotionGroup[]) {
    if (!profileKey.trim() || currentProfile.current !== profileKey) throw new Error("连接配置已切换，请重新打开动作组编辑");
    await shared.change(store => serializeMotionGroupStore({...store, profiles: {...store.profiles,
      [profileKey]: {groups: update(store.profiles[profileKey]?.groups ?? [])},
    }}));
  }
  return {
    groups: shared.value.profiles[profileKey]?.groups ?? [], ready: shared.ready, saving: shared.saving, error: shared.error,
    async saveGroup(group: MotionGroup, expected: string) {
      const error = validateMotionGroup(group);
      if (error) throw new Error(error);
      const snapshot = structuredClone(group);
      await change(groups => {
        assertMotionGroupUnchanged(groups.find(g => g.id === snapshot.id), expected);
        return [...groups.filter(g => g.id !== snapshot.id), snapshot];
      });
    },
    async deleteGroup(id: string, expected: string) {
      await change(groups => {
        assertMotionGroupUnchanged(groups.find(g => g.id === id), expected);
        return groups.filter(g => g.id !== id);
      });
    },
  };
}
