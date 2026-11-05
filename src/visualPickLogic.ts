import type { BridgeEnvelope, VisualPickPreview, VisualPickState } from "./types";
const phases = new Set(["idle","validating","opening","approaching","descending","closing","lifting","holding","failed","canceled","canceling","stop_failed"]);
export function parseVisualPickState(m:BridgeEnvelope):VisualPickState {
  if(m.op!=="visual_pick_state" || typeof m.command_id!=="string" || !phases.has(m.pick_phase??"") || typeof m.busy!=="boolean" || typeof m.message!=="string") throw new Error("抓取状态无效");
  return {command_id:m.command_id,phase:m.pick_phase!,message:m.message,busy:m.busy};
}
export function parseVisualPickPreview(m:BridgeEnvelope, token:string, id:number):VisualPickPreview {
  const validPose=(p:unknown) => {
    if(!p||typeof p!=="object")return false;const v=p as VisualPickPreview["grasp"];
    return Array.isArray(v.position)&&v.position.length===3&&v.position.every(x=>Number.isFinite(x)&&Math.abs(x)<4)&&
      Array.isArray(v.orientation)&&v.orientation.length===4&&v.orientation.every(Number.isFinite)&&Math.abs(Math.hypot(...v.orientation)-1)<.001;
  };
  if(m.op!=="visual_pick_preview"||m.subscription_id!==token||m.object_id!==id||!Number.isSafeInteger(m.frame_seq)||m.frame_seq!<1||
    typeof m.calibrated!=="boolean"||typeof m.execution_ready!=="boolean"||!validPose(m.grasp)||!validPose(m.pregrasp)||
    !Number.isFinite(m.opening_m)||typeof m.message!=="string")throw new Error("抓取预览数据或目标代次无效");
  return m as unknown as VisualPickPreview;
}
