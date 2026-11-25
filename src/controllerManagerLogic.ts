import { terminalPublish, terminalSession, logLevel, useTerminalMessage } from "./terminalLogLogic";
import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { ConnectionProfile, RemoteActionResult } from "./types";
import type { ArmProgress } from "./armModeWorkflowLogic";

export type ManagedController = { loadError?:string; name:string; typeName:string; state:string; requiredInterfaces:string[]; claimedInterfaces:string[]; interfacesKnown:boolean };
export type ManagerSnapshot = { manager:string; available:boolean; owned:boolean; updateRate:number|null; controllers:ManagedController[]; hardware:{name:string;state:string;plugin:string}[]; fingerprint:string };
export type ManagerRequest = { action:"start"|"load"|"switch"|"stop"; activate?:string[]; deactivate?:string[]; expected?:string };
export function activationPlan(snapshot:ManagerSnapshot, names:string[]): {activate:string[];deactivate:string[];error:string} {
  const selected=new Set(names), claims=new Map<string,string>();
  for(const name of names) {
    const row=snapshot.controllers.find(c=>c.name===name);
    if(!row || !["active","inactive"].includes(row.state)) return {activate:[],deactivate:[],error:`${name} 尚未完成加载和配置`};
    if(!row.interfacesKnown) return {activate:[],deactivate:[],error:`${name} 缺少所需接口信息，请更新 ROS 控制栈`};
    for(const key of row.requiredInterfaces) {
      const previous=claims.get(key);
      if(previous && previous!==name) return {activate:[],deactivate:[],error:`${previous} 与 ${name} 同时需要 ${key}，请调整选择`};
      claims.set(key,name);
    }
  }
  return {activate:names.filter(n=>snapshot.controllers.find(c=>c.name===n)?.state!=="active"),deactivate:snapshot.controllers.filter(c=>c.state==="active"&&!selected.has(c.name)&&c.claimedInterfaces.some(i=>claims.has(i))).map(c=>c.name),error:""};
}
export function useControllerManager(profile:ConnectionProfile, connected:boolean, active:boolean) {
  const context=JSON.stringify([profile,connected]);
  const latest=useRef(context);latest.current=context;
  const generation=useRef(0), pending=useRef<Promise<ManagerSnapshot|undefined>|null>(null);
  const busyRef=useRef(false), lastRead=useRef(0);
  const [snapshot,setSnapshot]=useState<ManagerSnapshot|null>(null);
  const [at,setAt]=useState(0),[now,setNow]=useState(Date.now());
  const [syncing,setSyncing]=useState(false),[refreshing,setRefreshing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [logs,setLogs]=useState<{at:number;message:string}[]>([]);
  const append=(message:string,task="",session?:string)=>{terminalPublish({source:"Controller",message,level:logLevel(message),task},session);setLogs(old=>[...old,{at:Date.now(),message:message.slice(0,4000)}].slice(-200));};
  useTerminalMessage("Controller",error,"error");
  async function refresh(source: "manual"|"background" = "manual") {
    if(!connected || busyRef.current) return;
    const ticket=generation.current,key=context;
    const current=()=>ticket===generation.current&&key===latest.current;
    if(source==="manual") setRefreshing(true);
    if(!pending.current) {
      setSyncing(true);
      const query=(async()=>{
        try {
          const value=await invoke<ManagerSnapshot>("controller_manager_snapshot",{profile});
          if(!current()) return;
          setSnapshot(value);setAt(Date.now());setNow(Date.now());setError("");return value;
        } catch(reason) {if(current()){setError(String(reason));setAt(0);}}
        finally {if(current()){lastRead.current=Date.now();setSyncing(false);}}
      })();
      pending.current=query;
      void query.finally(()=>{if(pending.current===query)pending.current=null;});
    }
    try {return await pending.current;} finally {if(current()&&source==="manual")setRefreshing(false);}
  }
  useEffect(()=>{
    generation.current++;setSnapshot(null);setAt(0);setBusy(false);busyRef.current=false;
    setRefreshing(false);setSyncing(false);setError("");setLogs([]);pending.current=null;lastRead.current=0;
    return()=>{generation.current++;};
  },[context]);
  useEffect(()=>{
    if(!active||!connected)return;
    let stopped=false;let timer:number|undefined;
    const tick=async()=>{
      const remaining=lastRead.current?5000-(Date.now()-lastRead.current):0;
      if(remaining<=0) await refresh("background");
      if(!stopped)timer=window.setTimeout(()=>void tick(),Math.max(5000-(Date.now()-lastRead.current),1000));
    };
    void tick();return()=>{stopped=true;window.clearTimeout(timer);};
  },[context,active]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  async function execute(request:ManagerRequest) {
    if(busyRef.current || !connected)return;
    const key=context,ticket=generation.current;
    const current=()=>latest.current===key&&generation.current===ticket;
    let finished=false;
    const session=terminalSession(),task=`controller-${Date.now()}-${ticket}`;
    const log=(message:string)=>append(message,task,session);
    busyRef.current=true;setBusy(true);log(`提交 ${request.action}${request.activate?.length?` · 启用 ${request.activate.join(", ")}`:""}${request.deactivate?.length?` · 停用 ${request.deactivate.join(", ")}`:""}`);
    const onProgress=new Channel<ArmProgress>();onProgress.onmessage=event=>{if(!finished)log(event.message);};
    try {const result=await invoke<RemoteActionResult>("controller_manager_manage",{profile,request,confirmed:true,onProgress});
      log([result.message,result.detail].filter(Boolean).join("："));if(current()){if(!result.ok)setError(result.detail||result.message);}
    }catch(reason){log(String(reason));if(current()){setError(String(reason));}}
    finally{finished=true;if(current()){await pending.current;if(current()){busyRef.current=false;setBusy(false);await refresh("background");}}}
  }
  return {snapshot,fresh:connected&&at>0&&now-at<10000,refreshing,syncing,busy,error,logs,refresh,execute};
}
