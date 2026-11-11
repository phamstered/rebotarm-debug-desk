import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
export type LocalTaskSnapshot = {id:number; window:string; kind:"capture"|"compute"; phase:"running"|"stopping"|"succeeded"|"failed"|"cancelled"; message:string};
const phases = {running:"处理中",stopping:"等待取消",succeeded:"已完成",failed:"失败",cancelled:"已取消"};
export function NativeLocalTaskStatus() {
  const [task,setTask] = useState<LocalTaskSnapshot|null>(null);
  const [error,setError] = useState("");
  useEffect(() => {
    let disposed=false, pending=false, running=false, unlisten:(()=>void)|undefined;
    const refresh=async()=>{
      pending=true; if(running)return; running=true;
      try { while(pending&&!disposed){pending=false;const next=await invoke<LocalTaskSnapshot|null>("native_local_task_snapshot");if(!disposed){setTask(next);setError("");}} }
      catch(reason){if(!disposed)setError(`手眼任务状态不可用：${String(reason)}`);}
      finally{running=false;}
    };
    void listen("native-local-tasks-changed",()=>void refresh()).then(stop=>{if(disposed)stop();else{unlisten=stop;void refresh();}}).catch(reason=>{if(!disposed)setError(String(reason));});
    return()=>{disposed=true;unlisten?.();};
  },[]);
  if(!error&&(!task||task.phase==="succeeded"))return null;
  return <div className="global-motion-status" role="status" aria-label="原生手眼任务">{error||`手眼${task!.kind==="capture"?"采集":"计算"} · ${phases[task!.phase]} · ${task!.message}`}</div>;
}
