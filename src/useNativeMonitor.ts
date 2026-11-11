import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { MonitorHistoryPage, NativeMonitorConfig } from "./types";

/** Capture remains in Rust when hidden. Only this bounded reader is suspended. */
export function useNativeMonitor({bridge,enabled,connected,visible,config,onPage}: {
  bridge: Pick<BridgeClient,"configureMonitor"|"monitorHistory">;
  enabled:boolean;connected:boolean;visible:boolean;config:NativeMonitorConfig;
  onPage(page:MonitorHistoryPage):void;
}) {
  const [configError,setConfigError]=useState(""), [readError,setReadError]=useState("");
  const cursor=useRef(0), callback=useRef(onPage); callback.current=onPage;
  const configKey=JSON.stringify(config);
  useEffect(()=>{cursor.current=0;setConfigError("");setReadError("");},[bridge,connected]);
  useEffect(()=>{
    if(!enabled||!connected)return;
    let disposed=false;
    void bridge.configureMonitor(JSON.parse(configKey) as NativeMonitorConfig)
      .then(()=>{if(!disposed)setConfigError("");})
      .catch(reason=>{if(!disposed)setConfigError(`Monitor 采集配置失败：${String(reason)}`);});
    return()=>{disposed=true;};
  },[bridge,enabled,connected,configKey]);
  useEffect(()=>{
    if(!enabled||!connected||!visible||config.paused)return;
    let disposed=false;let timer:ReturnType<typeof setTimeout>|undefined;
    const pull=async()=>{
      let delay=100;
      try{
        const page=await bridge.monitorHistory(cursor.current);
        if(disposed)return;
        callback.current(page);cursor.current=page.cursor;setReadError("");
        if(page.cursor<page.tail)delay=0;
      }catch(reason){if(!disposed){setReadError(`Monitor 历史读取失败：${String(reason)}`);delay=1000;}}
      if(!disposed)timer=setTimeout(()=>void pull(),delay);
    };
    void pull();
    return()=>{disposed=true;if(timer!==undefined)clearTimeout(timer);};
  },[bridge,enabled,connected,visible,config.paused]);
  return [configError,readError].filter(Boolean).join("；");
}
