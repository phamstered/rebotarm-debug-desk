import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { PAGE_TITLES } from "./nativeWorkspaceLogic";
type Operation={id:number;kind:"record"|"play";window:string;host:string;starting:boolean;phase:"submitting"|"verifying"|"uncertain"|"running"|"succeeded"|"failed";message:string};
const phases={submitting:"等待提交",verifying:"核验中",uncertain:"结果未确认",running:"运行中",succeeded:"已确认",failed:"未执行"};
export function NativeBagOperationStatus() {
  const [operations,setOperations]=useState<Operation[]>([]),[error,setError]=useState("");
  useEffect(()=>{
    let disposed=false,reading=false,pending=false,version=0;let stop:(()=>void)|undefined;
    const read=async()=>{
      pending=true;version++;if(reading)return;reading=true;
      try {while(pending&&!disposed){pending=false;const at=version;
        const value=await invoke<Operation[]>("native_bag_operation_snapshot");
        if(!Array.isArray(value))throw new Error("原生 rosbag 任务响应无效");
        if(!disposed&&at===version){setOperations(value);setError("");}
      }}catch(reason){if(!disposed)setError(String(reason));}
      finally{reading=false;if(pending&&!disposed)void read();}
    };
    void listen("native-bag-operations-changed",()=>void read()).then(unlisten=>{if(disposed)unlisten();else{stop=unlisten;void read();}}).catch(reason=>{if(!disposed)setError(String(reason));});
    return()=>{disposed=true;stop?.();};
  },[]);
  if(error)return <div className="global-motion-status" role="status">rosbag 任务状态不可用：{error}</div>;
  return <>{operations.filter(task=>task.phase!=="succeeded").map(task=><div key={`${task.kind}-${task.id}`} className="global-motion-status" role="status" aria-label="原生 rosbag 操作">
    {task.host} · {PAGE_TITLES[task.window.replace(/^page-/,"") as keyof typeof PAGE_TITLES]||task.window} · {task.kind==="record"?"录制":"回放"}{task.phase==="running"?"":task.starting?"启动":"停止"} · {phases[task.phase]} · {task.message}
  </div>)}</>;
}
