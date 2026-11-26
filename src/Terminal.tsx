import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { filterTerminal, formatTerminal, readTerminal, retainTerminal, type TerminalEntry } from './terminalLogLogic';
import { nativeDesktop } from './nativeWorkspaceLogic';
import { useNativeTaskSnapshot } from './nativeTaskSnapshotLogic';
import { NativeTaskStatus } from './NativeTaskStatus';
import { NativeLocalTaskStatus } from './NativeLocalTaskStatus';
import { NativeBagOperationStatus } from './NativeBagOperationStatus';
import { NativeCollectionOperationStatus } from './NativeCollectionOperationStatus';
import { CONTROL_LOG_SOURCES } from './controlLogLogic';
import type { ConnectionProfile } from './types';
import './terminal.css';
const sourceLabels:Record<string,string>={System:'系统',Connection:'连接',Task:'控制任务',Deploy:'Bridge 部署',Controller:'Controller 操作',Motion:'Motion',Motor:'Motor',Collection:'数据采集',Handeye:'手眼标定',Gravity:'重力辨识',Topics:'Topics',Monitor:'Monitor',URDF:'URDF',Camera:'图像',Window:'窗口',Rosbag:'Rosbag',teleop:'Teleop ROS',trajectory:'Trajectory / VLA ROS',teaching:'示教 ROS',moveit:'MoveIt ROS',controller:'Controller ROS',realsense:'RealSense ROS'};
const phases={submitting:'等待受理',running:'执行中',stopping:'等待停止确认',uncertain:'结果待核验'};
export function Terminal({visible=true,profile,windowKey="main"}:{visible?:boolean;profile?:ConnectionProfile;windowKey?:string}){
 const [entries,setEntries]=useState<TerminalEntry[]>([]),[current,setCurrent]=useState('local'),[sessions,setSessions]=useState<Record<string,string>>({local:'本地'});
 const [expanded,setExpanded]=useState(()=>localStorage.getItem(`terminal-open-${windowKey}`)!=='false');
 const [height,setHeight]=useState(()=>Math.min(600,Math.max(200,Number(localStorage.getItem(`terminal-height-${windowKey}`))||240)));
 const [maximized,setMaximized]=useState(false),[source,setSource]=useState(''),[level,setLevel]=useState('info+'),[task,setTask]=useState(''),[search,setSearch]=useState(''),[session,setSession]=useState('current');
 const [follow,setFollow]=useState(true),[after,setAfter]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState(''),[unread,setUnread]=useState(0),[top,setTop]=useState(0);
 const [details,setDetails]=useState<TerminalEntry|null>(null),[taskDetails,setTaskDetails]=useState(false),[saving,setSaving]=useState(false);
 const taskState=useNativeTaskSnapshot(nativeDesktop());
 const downloadContext=useRef({current,profile:JSON.stringify(profile),visible});
 downloadContext.current={current,profile:JSON.stringify(profile),visible};
 const mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const cursor=useRef(0),viewport=useRef<HTMLDivElement>(null),drag=useRef<{y:number;height:number}|null>(null),state=useRef({expanded,follow,visible,source,level,task,search,session});state.current={expanded,follow,visible,source,level,task,search,session};
 const focusEntry=useRef<number|null>(null);
 const bootstrap=useRef<number|null>(null);
 const revealed=useRef(new Set<string>());
 useEffect(()=>{let alive=true,timer:ReturnType<typeof setTimeout>;if(!visible){setEntries([]);cursor.current=0;bootstrap.current=null;}const poll=async()=>{try{const page=await readTerminal(visible?cursor.current:Number.MAX_SAFE_INTEGER);if(!alive)return;setCurrent(page.session);setSessions(page.sessions);if(!visible){timer=setTimeout(()=>void poll(),2000);return;}if(bootstrap.current===null)bootstrap.current=page.latest;cursor.current=page.cursor;
  if(page.archive_error)setNotice(`本地归档失败：${page.archive_error}`);if(page.truncated)setNotice('历史窗口已截断，较早日志可在本地归档或源日志中查找');if(page.archive_dropped)setNotice(`归档队列已丢弃 ${page.archive_dropped} 条，保留日志仍可导出`);
  if(page.entries.length){setEntries(old=>retainTerminal([...old,...page.entries.filter(row=>!old.some(e=>e.id===row.id))]));const errors=page.entries.filter(e=>e.level==='error'&&e.id>bootstrap.current!);setUnread(n=>n+errors.filter(e=>!state.current.visible||!state.current.expanded||!state.current.follow||Boolean(state.current.source&&state.current.source!==e.source)||Boolean(state.current.task&&state.current.task!==e.task)||Boolean(state.current.search)||!['','info+','error'].includes(state.current.level)||e.session!==page.session).length);
   const first=errors.find(e=>e.session===page.session&&e.task&&!revealed.current.has(`${e.session}:${e.task}`));if(first){revealed.current.add(`${first.session}:${first.task}`);setExpanded(true);}
  }setError('');timer=setTimeout(()=>void poll(),page.cursor<page.latest?10:500);
 }catch(e){if(alive){setError(String(e));timer=setTimeout(()=>void poll(),2000);}}};void poll();return()=>{alive=false;clearTimeout(timer);};},[visible]);
 useEffect(()=>{
  let alive=true;const stops:(()=>void)[]=[];
  const open=(detail?:{source?:string;task?:string;target?:string;entry?:TerminalEntry})=>{if(detail?.target&&detail.target!==windowKey)return;if(detail?.source==="Task")setTaskDetails(true);setExpanded(true);setSession('current');setSource(detail?.source??'');setTask(detail?.task??'');setSearch('');setLevel('info+');setAfter(0);setFollow(true);if(detail?.entry){const entry=detail.entry;setEntries(old=>retainTerminal([...old.filter(e=>e.id!==entry.id),entry].sort((a,b)=>a.id-b.id)));setSession(entry.session);setSource(entry.task?'':entry.source);setTask(entry.task);setLevel('');setFollow(false);focusEntry.current=entry.id;setDetails(entry);}};
  const localOpen=(event:Event)=>open((event as CustomEvent).detail);
  const failure=(event:Event)=>setNotice((event as CustomEvent).detail);
  window.addEventListener('terminal-open',localOpen);window.addEventListener('terminal-error',failure);
  if(nativeDesktop())for(const promise of [listen<{source?:string;task?:string;target?:string;entry?:TerminalEntry}>('terminal-open',e=>open(e.payload)),listen<string>('terminal-storage-error',e=>setNotice(`本地日志归档失败：${e.payload}`))])void promise.then(stop=>{if(alive)stops.push(stop);else stop();}).catch(e=>{if(alive)setNotice(String(e));});
  return()=>{alive=false;window.removeEventListener('terminal-open',localOpen);window.removeEventListener('terminal-error',failure);stops.forEach(stop=>stop());};
 },[windowKey]);
 useEffect(()=>{localStorage.setItem(`terminal-open-${windowKey}`,String(expanded));localStorage.setItem(`terminal-height-${windowKey}`,String(height));window.dispatchEvent(new Event('resize'));},[expanded,height,maximized,visible]);
 const filter={session:session==='current'?current:session,source,level,task,search,after};
 const filtered=useMemo(()=>filterTerminal(entries,filter),[entries,current,session,source,level,task,search,after]);
 useEffect(()=>{setTop(0);if(viewport.current)viewport.current.scrollTop=0;},[current,session,source,level,task,search,after]);
 const sources=[...new Set([...Object.keys(sourceLabels),...entries.map(e=>e.source)])].sort(),tasks=[...new Set(entries.map(e=>e.task).filter(Boolean))];
 useEffect(()=>{if(expanded&&follow&&viewport.current){const next=Math.max(0,filtered.length*28-viewport.current.clientHeight);viewport.current.scrollTop=next;setTop(next);}},[filtered.length,expanded,follow,visible,height]);
 async function exportLogs(all:boolean){if(saving)return;setSaving(true);try{if(!nativeDesktop()){const content=(all?entries.filter(e=>e.session===current):filtered).map(formatTerminal).join('\n');const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='robot-terminal.log';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);setNotice('已导出保留日志');return;}const path=await save({title:all?'导出本会话保留日志':'导出筛选日志',defaultPath:'robot-terminal.log',filters:[{name:'Log',extensions:['log']}]});if(!path)return;
 if(nativeDesktop())await invoke('terminal_export',{path,session:all?current:filter.session||null,source:all?null:source||null,level:all?null:level||null,task:all?null:task||null,search:all?null:search||null,after:all?0:after});
 else {const content=(all?entries.filter(e=>e.session===current):filtered).map(formatTerminal).join('\n');await invoke('save_motion_log',{localPath:path,content});}
 setNotice('已导出保留日志');}catch(e){setNotice(`导出失败：${String(e)}`);}finally{setSaving(false);}}
 async function downloadSource(){
  if(!profile||!source||saving)return;
  const started=downloadContext.current;
  const stillCurrent=()=>mounted.current&&downloadContext.current.visible&&downloadContext.current.current===started.current&&downloadContext.current.profile===started.profile;
  setSaving(true);
  try{
   const path=await save({defaultPath:`robot-${source}.log`,filters:[{name:'Log',extensions:['log']}]});
   if(path&&stillCurrent())await invoke('download_control_log',{profile,source,localPath:path});
  }catch(e){if(stillCurrent())setNotice(`源日志下载失败：${String(e)}`);}
  finally{if(mounted.current)setSaving(false);}
 }
 useEffect(()=>{if(focusEntry.current===null||!expanded)return;const index=filtered.findIndex(e=>e.id===focusEntry.current);if(index>=0&&viewport.current){const offset=Math.max(0,index*28-28);viewport.current.scrollTop=offset;setTop(offset);focusEntry.current=null;}},[filtered,expanded]);
 const start=Math.max(0,Math.floor(top/28)-5),end=Math.min(filtered.length,start+Math.ceil((maximized?window.innerHeight:height)/28)+12);
 const summary=!taskState.loaded?'任务状态同步中':taskState.error?'任务状态待核验':taskState.task?`${taskState.task.kind==='arm_mode'?'控制环境':taskState.task.kind} · ${phases[taskState.task.phase]}`:'共享控制空闲 · 任务详情';
 return <section className={`global-terminal${expanded?' expanded':''}${maximized&&expanded?' maximized':''}`} hidden={!visible} aria-label="全局 Terminal" style={{height:expanded?(maximized?'auto':height):36}}>
  {expanded&&!maximized&&<div role="separator" aria-label="调整 Terminal 高度" aria-orientation="horizontal" aria-valuenow={height} aria-valuemin={200} aria-valuemax={Math.max(200,window.innerHeight-240)} tabIndex={0} className="terminal-divider" onKeyDown={e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();setHeight(h=>Math.max(200,Math.min(window.innerHeight-240,h+(e.key==='ArrowUp'?20:-20))));}}} onPointerDown={e=>{drag.current={y:e.clientY,height};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(drag.current)setHeight(Math.max(200,Math.min(window.innerHeight-240,drag.current.height+drag.current.y-e.clientY)));}} onPointerUp={()=>drag.current=null} onLostPointerCapture={()=>drag.current=null}/>}
  <header className="terminal-header"><button aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>⌘_ <strong>Terminal</strong></button><span>{entries.length} 条</span><button aria-label="查看当前任务" className={`terminal-task${taskState.task||taskState.error?" has-task":""}`} onClick={()=>{setExpanded(true);setTaskDetails(v=>!v);}}>{summary}</button>{unread>0&&<button className="terminal-errors" onClick={()=>{setExpanded(true);setUnread(0);setSession('');setAfter(0);setLevel('error');setSource('');setTask('');setSearch('');setFollow(true);}}>● {unread} 未读错误</button>}<span className="terminal-spacer"/><button aria-label="最大化 / 恢复" title="最大化 / 恢复" onClick={()=>{setExpanded(true);setMaximized(v=>!v);}}>⛶</button><button aria-label={expanded?'收起 Terminal':'展开 Terminal'} onClick={()=>setExpanded(v=>!v)}>{expanded?'⌄':'⌃'}</button></header>
  {expanded&&<>
   <div className="terminal-tools"><select aria-label="日志会话" value={session} onChange={e=>setSession(e.target.value)}><option value="current">当前会话</option><option value="">全部会话</option>{Object.entries(sessions).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).map(([id,host],i)=><option key={id} value={id}>{host} · {id==='local'?'本地记录':`会话 ${i+1}${id.endsWith(':false')?'（离线）':''}`}</option>)}</select><select aria-label="日志来源" value={source} onChange={e=>setSource(e.target.value)}><option value="">全部来源</option>{sources.map(s=><option key={s} value={s}>{sourceLabels[s]??s}</option>)}</select><select aria-label="日志级别" value={level} onChange={e=>setLevel(e.target.value)}><option value="info+">INFO 及以上</option><option value="">全部级别</option>{['info','warn','error','debug'].map(s=><option key={s}>{s}</option>)}</select><select aria-label="关联任务" value={task} onChange={e=>setTask(e.target.value)}><option value="">全部任务</option>{tasks.map(s=><option key={s}>{s}</option>)}</select><input aria-label="搜索统一日志" type="search" placeholder="搜索日志、任务或错误…" value={search} onChange={e=>setSearch(e.target.value)}/><label className="terminal-follow"><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/><span>跟随最新</span></label><button onClick={()=>{setAfter(cursor.current);setUnread(0);}}>清屏</button><button disabled={saving} onClick={()=>void exportLogs(false)}>导出筛选</button><button disabled={saving} onClick={()=>void exportLogs(true)}>导出会话</button>{profile&&CONTROL_LOG_SOURCES.some(s=>s.id===source)&&<button disabled={saving||filter.session!==current} onClick={()=>void downloadSource()}>下载源日志</button>}</div>
   {(error||notice)&&<p className="terminal-notice" role="status">{error||notice}</p>}
   {taskDetails&&nativeDesktop()&&<div className="terminal-task-details"><NativeTaskStatus/><NativeLocalTaskStatus/><NativeBagOperationStatus/><NativeCollectionOperationStatus/></div>}
   <div className="terminal-columns"><span>时间</span><span>级别</span><span>来源</span><span>内容</span></div>
   <div className="terminal-viewport" ref={viewport} tabIndex={0} role="log" aria-live="off" aria-label="统一日志输出" onWheel={e=>{if(e.deltaY<0)setFollow(false);}} onKeyDown={e=>{if(['ArrowUp','PageUp','Home'].includes(e.key))setFollow(false);}} onPointerDown={()=>setFollow(false)} onScroll={e=>setTop(e.currentTarget.scrollTop)}>
    {!filtered.length?<p className="terminal-empty">{entries.length?'没有匹配日志，可调整筛选或清屏条件':'等待日志输出…'}</p>:<div style={{height:filtered.length*28,position:'relative'}}>{filtered.slice(start,end).map((entry,i)=><button key={entry.id} className={`terminal-row level-${entry.level}`} style={{top:(start+i)*28}} onClick={()=>setDetails(entry)} title={entry.message}><time>{new Date(entry.time).toLocaleTimeString('zh-CN',{hour12:false})}.{String(entry.time%1000).padStart(3,'0')}</time><span>{entry.level.toUpperCase()}</span><span title={entry.source}>{sourceLabels[entry.source]??entry.source}</span><span>{entry.task&&<small>[{entry.task}] </small>}{entry.message.replace(/\n/g,' ↵ ')}</span></button>)}</div>}
   </div><footer><span>{sessions[current]??'本地'} · 按接收顺序 · {filtered.length} 条匹配</span><button onClick={()=>{setAfter(0);setSource('');setLevel('');setTask('');setSearch('');}}>重置筛选 / 恢复清屏</button><span>{follow?'跟随最新':'跟随已暂停（采集继续）'}</span></footer>
  </>}
  {details&&<div className="terminal-detail-panel"><section role="dialog" aria-label="日志详情"><header className="toolbar-modal-title">{details.source} · {details.level.toUpperCase()}</header><pre className="terminal-detail">{formatTerminal(details)}</pre><footer className="toolbar-modal-actions"><button onClick={()=>void navigator.clipboard.writeText(formatTerminal(details)).catch(e=>setNotice(String(e)))}>复制记录</button><button onClick={()=>setDetails(null)}>关闭</button></footer></section></div>}
 </section>;
}
