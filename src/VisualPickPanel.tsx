import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { ObjectBox, VisualPickPreview, VisualPickState } from "./types";
import type { PositionMotionControls } from "./positionMotionLogic";
import {parseVisualPickPreview,parseVisualPickState} from "./visualPickLogic";
const idle:VisualPickState={command_id:"",phase:"idle",message:"",busy:false};
export function VisualPickPanel({bridge,token,selected,active,motion,onPreview,onBusy,onClear}:{
  bridge:BridgeClient;token:string;selected:ObjectBox|null;active:boolean;motion?:PositionMotionControls;
  onPreview(value:VisualPickPreview|null):void;onBusy(value:boolean):void;onClear():void;
}) {
  const [preview,setPreview]=useState<VisualPickPreview|null>(null),[state,setState]=useState(idle),[error,setError]=useState("");
  const owns=useRef("");
  useEffect(()=>{
    if(!active)return;
    let valid=true,polling=false;
    const apply=(s:VisualPickState)=>{if(!valid)return;setState(s);onBusy(s.busy);if(!s.busy)owns.current="";};
    const off=bridge.onMessage(m=>{if(m.op==="visual_pick_state"&&m.command_id===owns.current)try{apply(parseVisualPickState(m));}catch(e){setError(String(e));}});
    const poll=async()=>{if(polling)return;polling=true;try{const m=await bridge.request({op:"visual_pick_status"},2000);apply(parseVisualPickState(m));}catch(e){if(valid&&owns.current){setError(`抓取状态未确认：${String(e)}`);onBusy(true);}}finally{polling=false;}};
    void poll();const timer=window.setInterval(()=>void poll(),500);
    return()=>{valid=false;off();window.clearInterval(timer);if(owns.current){bridge.send({op:"visual_pick_cancel"});owns.current="";}onBusy(false);};
  },[bridge,active,onBusy]);
  useEffect(()=>{
    let valid=true,pending=false;setPreview(null);onPreview(null);setError("");
    if(!active||!selected||!token)return;
    const refresh=async()=>{if(pending||owns.current)return;pending=true;
      try{const result=await bridge.request({op:"visual_pick_preview",subscription_id:token,object_id:selected.id},2500);
        const p=parseVisualPickPreview(result,token,selected.id);if(valid){setPreview(p);onPreview(p);setError("");}}
      catch(e){if(valid){setPreview(null);onPreview(null);setError(e instanceof Error?e.message:String(e));}}
      finally{pending=false;}};
    void refresh();const timer=window.setInterval(()=>void refresh(),500);
    return()=>{valid=false;window.clearInterval(timer);};
  },[bridge,active,token,selected?.id,onPreview]);
  async function start(){
    if(!selected||!preview?.execution_ready||!motion?.armed||!active||state.busy||motion.reason||motion.tcpPoseReason||!motion.gripper?.available||!motion.gripper?.fresh)return;
    const id=crypto.randomUUID();owns.current=id;onBusy(true);setState({...idle,command_id:id,busy:true,phase:"validating"});
    try{const m=await bridge.request({op:"visual_pick_start",command_id:id,subscription_id:token,object_id:selected.id,preview_frame_seq:preview.frame_seq,confirmation:"ARMED"},5000);
      if(owns.current===id){const s=parseVisualPickState(m);setState(s);onBusy(s.busy);}}
    catch(e){if(owns.current===id){setError(String(e));bridge.send({op:"visual_pick_cancel"});}}
  }
  const blocked=!selected?"点击物体框选择目标":!preview?"等待有效候选姿态":!preview.execution_ready?preview.message:
    motion?.reason||motion?.tcpPoseReason||(!motion?.gripper?.available||!motion.gripper.fresh?"夹爪轨迹控制或新鲜反馈未就绪":"");
  if(!selected&&!state.busy&&state.phase==="idle")return <section aria-label="视觉抓取" className="visual-pick-panel"><strong>视觉抓取 · 分段闭环</strong><div>点击物体框选择目标并生成候选姿态</div></section>;
  return <section aria-label="视觉抓取" className="visual-pick-panel">
    <strong>视觉抓取 · 分段闭环</strong>
    <div>{selected?`已选物体 #${selected.id}`:"未选择当前可见目标"}</div>
    {preview&&<><div>候选抓取中心 mm：{preview.grasp.position.map(x=>(x*1000).toFixed(1)).join(" / ")}</div>
      <div>单指预张开 {(preview.opening_m*1000).toFixed(1)} mm · {preview.calibrated?"已标定":"未标定，仅预览"}</div><div>张开 → 分段接近 → 下降 → 闭合 → 抬升保持</div></>}
    {blocked&&<div style={{overflowWrap:"anywhere"}}>{blocked}</div>}
    <label><input type="checkbox" checked={motion?.armed??false} disabled={state.busy||!preview?.execution_ready} onChange={e=>motion?.setArmed(e.target.checked)}/> 已确认现场安全、夹爪为空，允许运动</label>
    <div className="viewer-overlay-row"><button disabled={Boolean(blocked)||!motion?.armed||state.busy} onClick={()=>void start()}>接近、抓取并抬升</button>
      <button disabled={!state.busy||!owns.current} onClick={()=>bridge.send({op:"visual_pick_cancel"})}>取消抓取</button>
      <button disabled={state.busy} onClick={onClear}>清除选择</button></div>
    {state.phase!=="idle"&&<div aria-live="polite">{state.phase} · {state.message}</div>}
    {error&&<div role="alert" style={{overflowWrap:"anywhere"}}>{error}</div>}
  </section>;
}
