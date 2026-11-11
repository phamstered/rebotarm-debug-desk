import { useRef } from "react";
import { addPosition, updatePosition, deletePosition, serializePositionStore, type PositionDraft, type PositionStore } from "./positionLogic";
import { assertPositionUnchanged, decodePositionStore } from "./positionStore";
import { useVersionedStore } from "./useVersionedStore";

export function usePositions(profileKey: string, enabled = true) {
  const shared = useVersionedStore("positions", decodePositionStore, enabled);
  const currentProfile = useRef(profileKey); currentProfile.current = profileKey;
  async function change(update: (store: PositionStore) => {store: PositionStore; error: string}) {
    try {
      if (!profileKey.trim() || currentProfile.current !== profileKey) throw new Error("连接配置已切换，请重新打开姿态编辑");
      await shared.change(store => {
        const next = update(store);
        if (next.error) throw new Error(next.error);
        return serializePositionStore(next.store);
      });
      return "";
    } catch (error) { return String(error); }
  }
  return {
    store: shared.value, ready: shared.ready, saving: shared.saving, error: shared.error,
    create(draft: PositionDraft) {
      const snapshot = structuredClone(draft), now = Date.now(), id = crypto.randomUUID();
      return change(store => addPosition(store, profileKey, snapshot, now, id));
    },
    update(id: string, draft: PositionDraft, expected: string) {
      const snapshot = structuredClone(draft), now = Date.now();
      return change(store => {
        assertPositionUnchanged(store.profiles[profileKey]?.positions.find(p => p.id === id), expected);
        return updatePosition(store, profileKey, id, snapshot, now);
      });
    },
    remove(id: string, expected: string) {
      return change(store => {
        assertPositionUnchanged(store.profiles[profileKey]?.positions.find(p => p.id === id), expected);
        return deletePosition(store, profileKey, id);
      });
    },
  };
}
