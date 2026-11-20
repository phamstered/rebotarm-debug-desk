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
  const generation=useRef(0), pending=useRef<symbol|null>(null);
  const [snapshot,setSnapshot]=useState<ManagerSnapshot|null>(null);
  const [at,setAt]=useState(0),[now,setNow]=useState(Date.now());
  const [refreshing,setRefreshing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [logs,setLogs]=useState<{at:number;message:string}[]>([]);
  const append=(message:string)=>setLogs(old=>[...old,{at:Date.now(),message:message.slice(0,4000)}].slice(-200));
  async function refresh() {
    if(!connected || pending.current) return;
    const query=Symbol();pending.current=query;setRefreshing(true);const ticket=generation.current, key=context;
    try {const value=await invoke<ManagerSnapshot>("controller_manager_snapshot",{profile});
      if(ticket!==generation.current||key!==latest.current) return;
      setSnapshot(value);setAt(Date.now());setError("");return value;
    } catch(reason) {if(ticket===generation.current&&key===latest.current){setError(String(reason));setAt(0);}}
    finally {if(pending.current===query)pending.current=null;if(ticket===generation.current&&key===latest.current)setRefreshing(false);}
  }
  useEffect(()=>{generation.current++;setSnapshot(null);setAt(0);setBusy(false);setError("");setLogs([]);pending.current=null;},[context]);
  useEffect(()=>{if(!active||!connected)return;void refresh();const timer=window.setInterval(()=>void refresh(),5000);return()=>window.clearInterval(timer);},[context,active]);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  async function execute(request:ManagerRequest) {
    if(busy || !connected)return;
    const key=context,ticket=generation.current;
    const current=()=>latest.current===key&&generation.current===ticket;
    setBusy(true);append(`提交 ${request.action}${request.activate?.length?` · 启用 ${request.activate.join(", ")}`:""}${request.deactivate?.length?` · 停用 ${request.deactivate.join(", ")}`:""}`);
    const onProgress=new Channel<ArmProgress>();onProgress.onmessage=event=>{if(current())append(event.message);};
    try {const result=await invoke<RemoteActionResult>("controller_manager_manage",{profile,request,confirmed:true,onProgress});
      if(current()){append([result.message,result.detail].filter(Boolean).join("："));if(!result.ok)setError(result.detail||result.message);}
    }catch(reason){if(current()){setError(String(reason));append(String(reason));}}
    finally{if(current()){setBusy(false);await refresh();}}
  }
  return {snapshot,fresh:connected&&at>0&&now-at<10000,refreshing,busy,error,logs,refresh,execute};
}
