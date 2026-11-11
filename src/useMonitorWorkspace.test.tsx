import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addSeriesToDashboardPanel, createDefaultMonitorWorkspace, MONITOR_STORAGE_KEY, persistMonitorWorkspace, renameMonitorDashboard, updateMonitorFromMessage } from "./monitorLogic";
import { createSeries } from "./dataGraphLogic";
import { useMonitorWorkspace } from "./useMonitorWorkspace";
const mock = vi.hoisted(() => ({ invoke:vi.fn(), handlers:new Set<(event:unknown)=>void>() }));
vi.mock("@tauri-apps/api/core",()=>({invoke:mock.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(_name:string,handler:(e:unknown)=>void)=>{mock.handlers.add(handler);return ()=>mock.handlers.delete(handler);})}));
let snapshot:{revision:number;content:string|null};
beforeEach(()=>{
  mock.handlers.clear();localStorage.clear();snapshot={revision:0,content:null};
  mock.invoke.mockReset().mockImplementation(async(command:string,args:any)=>{
    if(command==='editor_document_read')return {...snapshot};
    if(command==='editor_document_commit'){
      if(args.expected!==snapshot.revision)return {accepted:false,snapshot:{...snapshot}};
      snapshot={revision:snapshot.revision+1,content:args.content};
      mock.handlers.forEach(fn=>fn({payload:{key:'monitor',revision:snapshot.revision}}));
      return {accepted:true,snapshot:{...snapshot}};
    }
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(()=>{cleanup();mock.handlers.clear();});

it('migrates once, shares Topics edits with Monitor, and keeps samples out of persisted metadata',async()=>{
  const legacy=createDefaultMonitorWorkspace('/js');
  legacy.dashboards[0]!.name='Legacy layout';
  localStorage.setItem(MONITOR_STORAGE_KEY,JSON.stringify(persistMonitorWorkspace(legacy)));
  const monitor=renderHook(()=>useMonitorWorkspace('/js',true,true));
  const topics=renderHook(()=>useMonitorWorkspace('/js',true,true));
  const passive=renderHook(()=>useMonitorWorkspace('/js',true,false));
  await waitFor(()=>expect(monitor.result.current.ready&&topics.result.current.ready).toBe(true));
  expect(monitor.result.current.workspace.dashboards[0]!.name).toBe('Legacy layout');
  const id=topics.result.current.workspace.selectedDashboardId;
  expect(snapshot.revision).toBe(1);
  const initial=mock.invoke.mock.calls.filter(([command])=>command==='editor_document_commit').length;
  act(()=>monitor.result.current.setData(current=>updateMonitorFromMessage(current,'/js',{effort:[3]},10)));
  expect(monitor.result.current.workspace.dashboards[0]!.panels[0]!.series.points).toHaveLength(1);
  expect(mock.invoke.mock.calls.filter(([command])=>command==='editor_document_commit')).toHaveLength(initial);
  await act(async()=>{expect(await topics.result.current.change(current=>addSeriesToDashboardPanel(current,id,null,[createSeries('/extra','value',0)]))).toBe(true);});
  await waitFor(()=>expect(monitor.result.current.workspace.dashboards[0]!.panels).toHaveLength(8));
  expect(monitor.result.current.workspace.dashboards[0]!.panels[0]!.series.points).toEqual([{t:10,value:3}]);
  expect(snapshot.content).not.toContain('points');
  expect(JSON.parse(localStorage.getItem(MONITOR_STORAGE_KEY)!).dashboards[0].panels).toHaveLength(7);
  await act(async()=>{expect(await passive.result.current.change(current=>current)).toBe(false);});
});

it('rejects a stale bulk replacement and preserves drafts when persistence fails',async()=>{
  snapshot={revision:1,content:JSON.stringify(persistMonitorWorkspace(createDefaultMonitorWorkspace('/js')))};
  const a=renderHook(()=>useMonitorWorkspace('/js',true,true));
  const b=renderHook(()=>useMonitorWorkspace('/js',true,true));
  await waitFor(()=>expect(a.result.current.ready&&b.result.current.ready).toBe(true));
  const oldEditor=a.result.current;
  await act(async()=>{await b.result.current.change(current=>renameMonitorDashboard(current,current.selectedDashboardId,'New name'));});
  await act(async()=>{expect(await oldEditor.change(oldEditor.workspace)).toBe(false);});
  expect(a.result.current.error).toContain('其他窗口更新');
  expect(JSON.parse(snapshot.content!).dashboards[0].name).toBe('New name');
  const version=snapshot.revision;
  mock.invoke.mockRejectedValueOnce(new Error('disk unavailable'));
  await act(async()=>{expect(await a.result.current.change(current=>renameMonitorDashboard(current,current.selectedDashboardId,'Lost write'))).toBe(false);});
  expect(a.result.current.error).toContain('disk unavailable');expect(snapshot.revision).toBe(version);
});

it('does not resurrect deleted configuration from an old localStorage migration seed',async()=>{
  const owner=renderHook(()=>useMonitorWorkspace('/js',true,true));
  await waitFor(()=>expect(owner.result.current.ready).toBe(true));
  await act(async()=>{
    snapshot={revision:snapshot.revision+1,content:null};
    mock.handlers.forEach(fn=>fn({payload:{key:'monitor',revision:snapshot.revision}}));
  });
  expect(owner.result.current.ready).toBe(false);
  expect(owner.result.current.error).toContain('已被删除');
  expect(snapshot.content).toBeNull();
});
