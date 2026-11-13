import { observationValue, type SharedObservations } from "./nativeObservationsLogic";
import type { RosbagStatus, RosbagPlayStatus } from "./types";

/** Missing, failed and expired observations are unknown, never an idle recorder. */
export function sharedBagStatus(shared: Pick<SharedObservations, "connected" | "entries">) {
  function read<T>(source: "bag_record" | "bag_play"): {status:T|null; error:string} {
    if (!shared.connected) return {status:null,error:""};
    try { return {status:observationValue<T>(shared.entries[source]),error:""}; }
    catch (reason) { return {status:null,error:reason instanceof Error ? reason.message : String(reason)}; }
  }
  return {record:read<RosbagStatus>("bag_record"),play:read<RosbagPlayStatus>("bag_play")};
}
