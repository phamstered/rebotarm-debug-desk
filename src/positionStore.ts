import { invoke } from "@tauri-apps/api/core";
import { emptyPositionStore, parsePositionStore, serializePositionStore, type PositionStore } from "./positionLogic";

export async function loadStoredPositions(): Promise<PositionStore> {
  try {
    const raw = await invoke<string | null>("positions_load");
    const parsed = parsePositionStore(raw, "");
    return { schemaVersion: parsed.schemaVersion, profiles: parsed.profiles };
  } catch {
    return emptyPositionStore();
  }
}

export async function saveStoredPositions(store: PositionStore) {
  await invoke("positions_save", { content: serializePositionStore(store) });
}
