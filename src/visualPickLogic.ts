import type { BridgeEnvelope, VisualPickPreview, VisualPickState, RgbTargetState } from "./types";
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
  if(m.tracking!=null){const t=parseRgbTarget(m.tracking);if(t.object_id!==id)throw new Error("跟踪目标不匹配");}
  return m as unknown as VisualPickPreview;
}

export function parseRgbTarget(value:unknown):RgbTargetState {
  const t=value as RgbTargetState;
  if(!t||typeof t!=="object"||typeof t.target_id!=="string"||! /^[a-f0-9-]{36}$/.test(t.target_id)||
    !Number.isSafeInteger(t.object_id)||t.object_id<1||!Number.isSafeInteger(t.sequence)||t.sequence<1||
    !Number.isSafeInteger(t.generation)||t.generation<0||!["confirming","rgbd","rgb","uncertain"].includes(t.mode)||
    typeof t.identity_valid!=="boolean"||typeof t.metric_ready!=="boolean"||typeof t.plane_verified!=="boolean"||
    !Number.isFinite(t.confidence)||t.confidence<0||t.confidence>1||!Number.isFinite(t.age_ms)||t.age_ms<0||
    !Number.isFinite(t.camera_z_m)||!Number.isFinite(t.depth_valid_fraction)||t.depth_valid_fraction<0||t.depth_valid_fraction>1||
    typeof t.message!=="string"||typeof t.source_frame!=="string"||t.target_frame!=="base_link"||typeof t.geometry_source!=="string"||
    !Number.isFinite(t.stamp_ns)||t.stamp_ns<=0||!Array.isArray(t.roi)||t.roi.length!==4||!t.roi.every(Number.isFinite)||t.roi.some(x=>x<0)||
    !t.box||t.box.id!==t.object_id||!Number.isSafeInteger(t.box.point_count)||t.box.point_count<0||![t.box.center,t.box.size].every(a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite))||t.box.size.some(x=>x<=0||x>.5)||t.box.center.some(x=>Math.abs(x)>3))throw new Error("RGB 目标跟踪数据无效");
  if(t.metric_ready&&(!t.identity_valid||(t.mode==="rgb"&&!t.plane_verified)))throw new Error("RGB 目标几何门禁无效");
  if((t.mode==="uncertain"||t.mode==="confirming")&&(t.identity_valid||t.metric_ready))throw new Error("RGB 目标身份门禁无效");
  return t;
}
export function acceptRgbTarget(previous:RgbTargetState|null,next:RgbTargetState,targetId:string,objectId:number):boolean {
  return next.target_id===targetId&&next.object_id===objectId&&(!previous||
    (next.generation===previous.generation&&next.sequence>=previous.sequence&&next.stamp_ns>=previous.stamp_ns&&
     (previous.mode!=="uncertain"||next.mode==="uncertain")));
}
