import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openTerminal, operationFailureSummary, type TerminalEntry } from './terminalLogLogic';
import './errorNotifications.css';
export type ErrorNotice = {entry:TerminalEntry;title:string;summary?:string;key?:string};
function ErrorCard({notice,close,open}:{notice:ErrorNotice;close():void;open():void}) {
 return <article className="error-toast" role="alert" aria-label={notice.title}>
  <header><span aria-hidden="true">⊗</span><strong>{notice.title}</strong><button aria-label="关闭错误提示" onClick={close}>×</button></header>
  <p>{notice.summary || operationFailureSummary(notice.entry.message)}</p>
  <footer><button onClick={open}>查看日志 →</button></footer>
 </article>;
}
/** Dedicated non-activating native child window: no App, subscriptions or controls. */
export function NativeErrorNotification() {
 const [notice,setNotice]=useState<ErrorNotice|null>(null);
 useEffect(()=>{let alive=true;void invoke<ErrorNotice|null>('notification_read').then(value=>{if(alive)setNotice(value);});return()=>{alive=false;};},[]);
 useEffect(()=>{if(!notice)return;const frame=requestAnimationFrame(()=>{void invoke('notification_presented');});return()=>cancelAnimationFrame(frame);},[notice]);
 return notice?<ErrorCard notice={notice} close={()=>void invoke('notification_close',{openLog:false})} open={()=>void invoke('notification_close',{openLog:true})}/>:null;
}
/** Browser fallback has the same transient lifecycle; historical Terminal reads never feed it. */
export function ErrorNotifications({target='main'}:{target?:string}) {
 const [notices,setNotices]=useState<ErrorNotice[]>([]);const seen=useRef(new Set<string>());
 useEffect(()=>{const receive=(event:Event)=>{const notice=(event as CustomEvent<ErrorNotice>).detail;const key=`${notice.entry.session}:${notice.key}`;
  if(seen.current.has(key))return;seen.current.add(key);if(seen.current.size>4096)seen.current.delete(seen.current.values().next().value!);
  setNotices(old=>[...old,notice].slice(-3));};window.addEventListener('operation-failure',receive);return()=>window.removeEventListener('operation-failure',receive);},[]);
 return <div className="error-toast-stack" aria-label="错误通知">{notices.map(notice=><TimedError key={notice.entry.id} notice={notice} close={()=>setNotices(old=>old.filter(n=>n.entry.id!==notice.entry.id))} open={()=>{openTerminal(undefined,undefined,target,notice.entry);setNotices(old=>old.filter(n=>n.entry.id!==notice.entry.id));}}/>)}</div>;
}
function TimedError(props:{notice:ErrorNotice;close():void;open():void}) {
 const close=useRef(props.close);close.current=props.close;
 useEffect(()=>{const timer=setTimeout(()=>close.current(),3000);return()=>clearTimeout(timer);},[]);
 return <ErrorCard {...props}/>;
}
