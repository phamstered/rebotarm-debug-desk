import { useEffect, useState, type ReactNode } from "react";
import { activationPlan, useControllerManager, type ManagerRequest } from "./controllerManagerLogic";
import type { ConnectionProfile } from "./types";
import { ActionButton } from "./ActionButton";
import "./controllerManager.css";

export function ControllerManagerPanel({profile,connected,active,disabledReason,presets}:{profile:ConnectionProfile;connected:boolean;active:boolean;disabledReason:string;presets:ReactNode}) {
 const manager=useControllerManager(profile,connected,active);
 const {snapshot,fresh,busy,refreshing,error,logs}=manager;
 const [tab,setTab]=useState<"presets"|"controllers">("controllers");
 const [search,setSearch]=useState(""),[selected,setSelected]=useState<string[]>([]);
 const [confirmation,setConfirmation]=useState<ManagerRequest|null>(null),[supported,setSupported]=useState(false),[planError,setPlanError]=useState("");
 const key=JSON.stringify([profile,connected]);
 useEffect(()=>{setConfirmation(null);setSupported(false);setSelected([]);setPlanError("");},[key]);
 const rows=snapshot?.controllers??[], blocked=busy||Boolean(disabledReason)||!connected;
 const stateLabel:Record<string,string>={unloaded:"未加载",unconfigured:"未配置",inactive:"已加载 · 未激活",active:"运行中",finalized:"已结束",error:"异常",unknown:"未知"};
 function ask(request:ManagerRequest){setPlanError("");setSupported(false);setConfirmation({...request,expected:snapshot?.fingerprint});}
 function activate(names:string[]){if(!snapshot)return;const plan=activationPlan(snapshot,names);if(plan.error){setPlanError(plan.error);return;}if(!plan.activate.length&&!plan.deactivate.length){setPlanError("所选 Controller 已激活");return;}ask({action:"switch",activate:plan.activate,deactivate:plan.deactivate});}
 const mismatch=confirmation?.expected!==snapshot?.fingerprint;
 return <div className="controller-manager-page">
  <section className="manager-summary" aria-label="Controller Manager">
   <div><span className="manager-eyebrow">CONTROLLER MANAGER</span><h2>{fresh?(snapshot?.available?"Manager 在线":"Manager 未启动"):"Manager 状态待确认"}</h2><p>{snapshot?.manager??"/controller_manager"} · {snapshot?.updateRate??"—"} Hz · {snapshot?.owned?"应用管理的进程":"外部或尚未启动"}</p></div>
   <div className="manager-counts"><strong>{rows.filter(r=>r.state!=="unloaded").length}<small>已加载 / {rows.length}</small></strong><strong>{rows.filter(r=>r.state==="active").length}<small>已激活</small></strong></div>
   <div className="manager-actions"><ActionButton disabled={blocked||!fresh} onClick={()=>ask({action:snapshot?.available?"load":"start"})}>{snapshot?.available?"补加载 / 重试未配置项":"启动并加载全部"}</ActionButton><ActionButton disabled={refreshing||busy||!connected} onClick={()=>void manager.refresh()}>{refreshing?"刷新中…":"刷新"}</ActionButton><ActionButton disabled={blocked||!fresh||!snapshot?.available||!snapshot.owned||rows.some(r=>r.state==="active")} onClick={()=>ask({action:"stop"})}>停止 Manager</ActionButton></div>
  </section>
  <p className="manager-note">默认全部加载并配置为 inactive，按需启用。停用 Controller 会保留加载状态；它不等同于关闭电机输出。</p>
  {disabledReason&&<p role="status" className="manager-warning">{disabledReason}</p>}
  {(error||planError)&&<p role="alert" className="manager-error">{planError||error}</p>}
  <div className="manager-tabs" role="tablist" aria-label="控制管理"><button role="tab" aria-selected={tab==="presets"} onClick={()=>setTab("presets")}>模式预设</button><button role="tab" aria-selected={tab==="controllers"} onClick={()=>setTab("controllers")}>Controller 管理</button></div>
  <section hidden={tab!=="presets"} role="tabpanel" aria-label="模式预设">{presets}</section>
  <section hidden={tab!=="controllers"} role="tabpanel" aria-label="Controller 管理">
   <div className="manager-toolbar"><label>搜索 Controller<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="名称、类型或接口"/></label><span>已选 {selected.length}</span><ActionButton disabled={blocked||!fresh||!selected.length} onClick={()=>activate(selected)}>启用所选</ActionButton><ActionButton disabled={blocked||!fresh||!selected.some(n=>rows.find(r=>r.name===n)?.state==="active")} onClick={()=>ask({action:"switch",activate:[],deactivate:selected.filter(n=>rows.find(r=>r.name===n)?.state==="active")})}>停用所选</ActionButton></div>
   <div className="manager-table-scroll"><table className="manager-table"><thead><tr><th>选择</th><th>Controller / 类型</th><th>实际状态</th><th>所需命令接口</th><th>操作</th></tr></thead><tbody>
    {rows.filter(c=>JSON.stringify(c).toLowerCase().includes(search.toLowerCase())).map(c=><tr key={c.name}><td><input type="checkbox" aria-label={`选择 ${c.name}`} checked={selected.includes(c.name)} onChange={e=>setSelected(s=>e.target.checked?[...s,c.name]:s.filter(n=>n!==c.name))}/></td><td><strong>{c.name}</strong><small>{c.typeName}</small>{c.loadError&&<small className="manager-error">上次加载失败：{c.loadError}</small>}</td><td><span className={`manager-state ${fresh?c.state:"unknown"}`}>{fresh?(stateLabel[c.state]??c.state):"未知（上次状态）"}</span></td><td><details><summary>{c.interfacesKnown?`${c.requiredInterfaces.length} 个接口`:"等待配置 / 接口信息"}</summary>{c.requiredInterfaces.map(i=><code key={i}>{i}</code>)}</details></td><td><ActionButton disabled={blocked||!fresh||!["active","inactive"].includes(c.state)} onClick={()=>c.state==="active"?ask({action:"switch",activate:[],deactivate:[c.name]}):activate([c.name])}>{c.state==="active"?"停用":"启用"}</ActionButton></td></tr>)}
   </tbody></table></div>
   {!rows.length&&<p className="manager-empty">{fresh&&!snapshot?.available?"启动 Manager 后，从机器人配置加载 Controller。":"等待 Manager 配置与实际状态。"}</p>}
   {snapshot?.hardware.map(h=><p className="manager-note" key={h.name}>硬件 {h.name} · {h.state}</p>)}
  </section>
  <section className="manager-history" aria-label="管理操作历史"><header><h3>操作历史</h3><span>保留本次连接最近 200 条 · 切换页面不清除</span></header>{logs.length?<ol>{logs.map((l,i)=><li key={i}><time>{new Date(l.at).toLocaleTimeString()}</time><span>{l.message}</span></li>)}</ol>:<p>尚无管理操作。操作进度和失败原因会保留在这里。</p>}</section>
  {confirmation&&<div className="modal-backdrop"><section className="toolbar-modal" role="dialog" aria-modal="true" aria-label="确认 Controller Manager 操作"><header className="toolbar-modal-title"><strong>确认 {confirmation.action==="switch"?"Controller 切换":confirmation.action==="stop"?"停止 Manager":"加载 Controller"}</strong></header><div className="toolbar-modal-content">
   {confirmation.action==="switch"?<><p>启用：{confirmation.activate?.join(", ")||"无"}</p><p className={confirmation.deactivate?.length?"manager-warning":""}>停用：{confirmation.deactivate?.join(", ")||"无"}</p><p>启用可能激活硬件并产生保持力矩；若存在接口冲突，将先停用上面列出的 Controller。实际结果以服务执行后的读回为准。</p></>:<p>{confirmation.action==="stop"?"仅停止本应用创建的进程。必须全部停用且核验新鲜 DISABLE，停止进程不能替代关闭输出。":"加载当前机器人配置中的全部 Controller，包括 broadcaster；只配置到 inactive，不自动激活。已有 active 保持不变。"}</p>}
   <label className="safety-check"><input type="checkbox" checked={supported} onChange={e=>setSupported(e.target.checked)}/>已核对操作对象、现场支撑及运动区域</label>{mismatch&&<p role="alert">实际状态已改变，请取消并重新确认。</p>}</div><footer className="toolbar-modal-actions"><ActionButton onClick={()=>setConfirmation(null)}>取消</ActionButton><ActionButton disabled={!supported||blocked||!fresh||mismatch} onClick={()=>{const request=confirmation;setConfirmation(null);void manager.execute(request);}}>确认执行</ActionButton></footer></section></div>}
 </div>;
}
