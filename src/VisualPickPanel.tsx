import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { ObjectBox, RgbTargetState, VisualPickPreview, VisualPickState } from "./types";
import type { PositionMotionControls } from "./positionMotionLogic";
import {acceptRgbTarget,parseRgbTarget,parseVisualPickPreview,parseVisualPickState} from "./visualPickLogic";
import {decodeRosImage} from "./imageTopicLogic";
const idle:VisualPickState={command_id:"",phase:"idle",message:"",busy:false};
export function VisualPickPanel({bridge,token,selected,selectionRevision=0,active,motion,onPreview,onBusy,onClear}:{
  bridge:BridgeClient;token:string;selected:ObjectBox|null;selectionRevision?:number;active:boolean;motion?:PositionMotionControls;
  onPreview(value:VisualPickPreview|null):void;onBusy(value:boolean):void;onClear():void;
}) {
  const [preview,setPreview]=useState<VisualPickPreview|null>(null),[state,setState]=useState(idle),[error,setError]=useState("");
  const owns=useRef("");
  // Serialize selection/release with in-flight previews; remember their server
  // binding even when the selection changed while awaiting the response.
  const requests=useRef<Promise<unknown>>(Promise.resolve());
  const serverBinding=useRef<{token:string;targetId:string}|null>(null);
  const leaseTimer=useRef<number|undefined>(undefined);
  function applyTracking(t:RgbTargetState) {
    if(leaseTimer.current!==undefined)window.clearTimeout(leaseTimer.current);
    const expire=()=>{
      const current=bound.current;
      if(!current)return;
      const expired=current.mode==="uncertain"?current:{...current,mode:"uncertain" as const,identity_valid:false,metric_ready:false,confidence:0,message:"RGB 观测过期，请点击物体框重新选择"};
      bound.current=expired;setTracking(expired);setPreview(null);onPreview(null);
    };
    bound.current=t;setTracking(t);
    if(t.age_ms>=500){expire();return;}
    leaseTimer.current=window.setTimeout(expire,500-t.age_ms);
    if(!t.identity_valid){setPreview(null);onPreview(null);}
  }
  const selectionVersion=useRef(0);
  const releasing=useRef(false);const [clearing,setClearing]=useState(false);
  const [tracking,setTracking]=useState<RgbTargetState|null>(null);
  const bound=useRef<RgbTargetState|null>(null),canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    selectionVersion.current++;bound.current=null;setTracking(null);releasing.current=false;setClearing(false);
    if(!active||!selected||!token)return;
    let valid=true,raf:number|null=null;
    let pending:import("./types").BridgeEnvelope|null=null;
    const off=bridge.onMessage(m=>{
      if(m.op!=="visual_target_frame"||m.subscription_id!==token||!valid)return;
      pending=m;if(raf!==null)return;
      raf=window.requestAnimationFrame(()=>{
        raf=null;const frame=pending;pending=null;if(!valid||!frame||!bound.current)return;
        try{
          const t=parseRgbTarget(frame.tracking);
          if(!acceptRgbTarget(bound.current,t,bound.current.target_id,selected.id))return;
          applyTracking(t);
          if(frame.target_rgb_payload&&frame.rgb&&typeof frame.rgb==="object"){
            const image=decodeRosImage({...frame.rgb,data_bytes:frame.target_rgb_payload});
            const el=canvas.current;if(el){el.width=image.width;el.height=image.height;const ctx=el.getContext("2d");
              if(ctx){ctx.putImageData(new ImageData(new Uint8ClampedArray(image.rgba),image.width,image.height),0,0);
                ctx.strokeStyle=t.identity_valid?"#49dfad":"#ffbc66";ctx.lineWidth=2;ctx.strokeRect(...t.roi);}}
          }
        }catch(e){setError(String(e));setPreview(null);onPreview(null);}
      });
    });
    return()=>{valid=false;off();if(raf!==null)window.cancelAnimationFrame(raf);if(leaseTimer.current!==undefined)window.clearTimeout(leaseTimer.current);};
  },[bridge,active,token,selected?.id,selectionRevision,onPreview]);
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
    let valid=true,pending=false,needsRelease=true;setPreview(null);onPreview(null);setError("");
    if(!active||!selected||!token)return;
    const refresh=async()=>{if(pending||owns.current||releasing.current)return;pending=true;
      const work=requests.current.catch(()=>{}).then(async()=>{
        if(!valid||releasing.current)return;
        const old=serverBinding.current;
        if(needsRelease&&old?.token===token){
          const result=await bridge.request({op:"visual_target_release",subscription_id:token,target_id:old.targetId},2500);
          if(result.op!=="visual_target_released")throw new Error("目标释放响应无效");
          if(serverBinding.current===old)serverBinding.current=null;
        }
        needsRelease=false;
        if(!valid||releasing.current)return;
        const result=await bridge.request({op:"visual_pick_preview",subscription_id:token,object_id:selected.id},2500);
        const p=parseVisualPickPreview(result,token,selected.id);
        if(p.tracking)serverBinding.current={token,targetId:p.tracking.target_id};
        if(!valid||releasing.current)return;
        if(p.tracking){
          if(bound.current&&!acceptRgbTarget(bound.current,p.tracking,bound.current.target_id,selected.id))return;
          applyTracking(p.tracking);
        }
        const visible=!p.tracking||(p.tracking.age_ms<500&&p.tracking.identity_valid&&p.tracking.metric_ready);
        setPreview(visible?p:null);onPreview(visible?p:null);setError("");
      });
      requests.current=work;
      try{await work;}catch(e){if(valid){setPreview(null);onPreview(null);setError(e instanceof Error?e.message:String(e));}}
      finally{pending=false;}};
    void refresh();const timer=window.setInterval(()=>void refresh(),500);
    return()=>{valid=false;window.clearInterval(timer);};
  },[bridge,active,token,selected?.id,selectionRevision,onPreview]);
  async function start(){
    if(releasing.current||(bound.current&&(!bound.current.identity_valid||!bound.current.metric_ready))||!selected||!preview?.execution_ready||!motion?.armed||!active||state.busy||motion.reason||motion.tcpPoseReason||!motion.gripper?.available||!motion.gripper?.fresh)return;
    const id=crypto.randomUUID();owns.current=id;onBusy(true);setState({...idle,command_id:id,busy:true,phase:"validating"});
    try{const m=await bridge.request({op:"visual_pick_start",command_id:id,subscription_id:token,object_id:selected.id,preview_frame_seq:preview.frame_seq,...(preview.tracking?{target_id:preview.tracking.target_id}:{}),confirmation:"ARMED"},5000);
      if(owns.current===id){const s=parseVisualPickState(m);setState(s);onBusy(s.busy);}}
    catch(e){if(owns.current===id){setError(String(e));bridge.send({op:"visual_pick_cancel"});}}
  }
  async function clear(){
    if(releasing.current)return;const version=selectionVersion.current;releasing.current=true;setClearing(true);
    try{
      const work=requests.current.catch(()=>{}).then(async()=>{
        const old=serverBinding.current;
        if(old?.token===token){
          const result=await bridge.request({op:"visual_target_release",subscription_id:token,target_id:old.targetId},2500);
          if(result.op!=="visual_target_released")throw new Error("目标释放响应无效");
          if(serverBinding.current===old)serverBinding.current=null;
        }
      });
      requests.current=work;await work;
      if(version!==selectionVersion.current)return;
      bound.current=null;setTracking(null);setPreview(null);onPreview(null);onClear();
    }catch(e){if(version!==selectionVersion.current)return;releasing.current=false;setClearing(false);setError(`释放目标失败：${String(e)}`);}
  }
  const blocked=clearing?"正在释放目标":!selected?"点击物体框选择目标":tracking&&(!tracking.identity_valid||!tracking.metric_ready)?tracking.message:!preview?"等待有效候选姿态":!preview.execution_ready?preview.message:
    motion?.reason||motion?.tcpPoseReason||(!motion?.gripper?.available||!motion.gripper.fresh?"夹爪轨迹控制或新鲜反馈未就绪":"");
  if(!selected&&!state.busy&&state.phase==="idle")return <section aria-label="视觉抓取" className="visual-pick-panel"><strong>视觉抓取 · 分段闭环</strong><div>点击物体框选择目标并生成候选姿态</div></section>;
  return <section aria-label="视觉抓取" className="visual-pick-panel">
    <strong>视觉抓取 · 分段闭环</strong>
    <div>{selected?`已选物体 #${selected.id}`:"未选择当前可见目标"}</div>
    {tracking&&<div aria-live="polite">
      <div>目标 {tracking.target_id.slice(0,8)} · {{confirming:"核验中",rgbd:"RGBD",rgb:"RGB",uncertain:"身份待确认"}[tracking.mode]} · 置信度 {(tracking.confidence*100).toFixed(0)}%</div>
      <div>{tracking.mode==="rgb"?tracking.plane_verified?"固定顶面几何已核验":"固定顶面未核验，禁止接近":tracking.message}</div>
    </div>}
    {tracking&&<canvas ref={canvas} aria-label="所选目标 RGB 跟踪区域" style={{display:"block",width:"100%",maxWidth:320,aspectRatio:"4 / 3",opacity:tracking.mode==="uncertain"?.45:1}}/>}
    {preview&&<><div>候选抓取中心 mm：{preview.grasp.position.map(x=>(x*1000).toFixed(1)).join(" / ")}</div>
      <div>单指预张开 {(preview.opening_m*1000).toFixed(1)} mm · {preview.calibrated?"已标定":"未标定，仅预览"}</div><div>张开 → 分段接近 → 下降 → 闭合 → 抬升保持</div></>}
    {blocked&&<div style={{overflowWrap:"anywhere"}}>{blocked}</div>}
    <label><input type="checkbox" checked={motion?.armed??false} disabled={state.busy||!preview?.execution_ready} onChange={e=>motion?.setArmed(e.target.checked)}/> 已确认现场安全、夹爪为空，允许运动</label>
    <div className="viewer-overlay-row"><button disabled={Boolean(blocked)||!motion?.armed||state.busy} onClick={()=>void start()}>接近、抓取并抬升</button>
      <button disabled={!state.busy||!owns.current} onClick={()=>bridge.send({op:"visual_pick_cancel"})}>取消抓取</button>
      <button disabled={state.busy||clearing} onClick={()=>void clear()}>清除选择</button></div>
    {state.phase!=="idle"&&<div aria-live="polite">{state.phase} · {state.message}</div>}
    {error&&<div role="alert" style={{overflowWrap:"anywhere"}}>{error}</div>}
  </section>;
}
