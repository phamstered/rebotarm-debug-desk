import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Terminal } from './Terminal';
import type { TerminalEntry } from './terminalLogLogic';
const mock=vi.hoisted(()=>({invoke:vi.fn(),save:vi.fn(),events:new Map<string,Set<(event:{payload:any})=>void>>(),rows:[] as TerminalEntry[],session:'one'}));
vi.mock('./nativeWorkspaceLogic',()=>({nativeDesktop:()=>true,PAGE_TITLES:{control:'控制模式'}}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mock.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async(name:string,callback:(e:{payload:any})=>void)=>{if(!mock.events.has(name))mock.events.set(name,new Set());mock.events.get(name)!.add(callback);return()=>mock.events.get(name)?.delete(callback);})}));
vi.mock('@tauri-apps/plugin-dialog',()=>({save:mock.save}));
const row=(id:number,patch:Partial<TerminalEntry>={}):TerminalEntry=>({id,time:Date.now(),session:'one',host:'robot',source:'Controller',task:'',level:'info',message:`line ${id}`,...patch});
async function tick(ms=500){await act(async()=>vi.advanceTimersByTimeAsync(ms));}
beforeEach(()=>{
 vi.useFakeTimers();localStorage.clear();mock.rows=[];mock.session='one';mock.events.clear();mock.invoke.mockReset();mock.save.mockReset();
 mock.invoke.mockImplementation(async(command,args)=>{
  if(command==='terminal_read'){const entries=mock.rows.filter(e=>e.id>args.after).slice(0,256);return{entries,cursor:entries.at(-1)?.id??args.after,latest:mock.rows.at(-1)?.id??0,session:mock.session,host:'robot',sessions:{one:'robot',two:'robot'},truncated:false,archive_dropped:0};}
  if(command==='native_bag_operation_snapshot')return [];
  return null;
 });
});
afterEach(()=>vi.useRealTimers());
it('continues collecting while collapsed, follows once per failed task, and preserves history after clear',async()=>{
 localStorage.setItem('terminal-open-main','false');render(<Terminal/>);await tick(0);
 mock.rows.push(row(1,{level:'error',task:'job',message:'启动失败'}));await tick();
 expect(screen.getByRole('log')).toHaveTextContent('启动失败');
 fireEvent.click(screen.getByRole('button',{name:'收起 Terminal'}));
 mock.rows.push(row(2,{level:'error',task:'job',message:'同任务后续错误'}));await tick();
 expect(screen.queryByRole('log')).toBeNull();expect(screen.getByText(/未读错误/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'展开 Terminal'}));
 fireEvent.click(screen.getByRole('button',{name:'清屏'}));expect(screen.getByRole('log')).not.toHaveTextContent('启动失败');
 mock.rows.push(row(3));await tick();expect(screen.getByRole('log')).toHaveTextContent('line 3');
 fireEvent.click(screen.getByRole('button',{name:'重置筛选 / 恢复清屏'}));expect(screen.getByRole('log')).toHaveTextContent('启动失败');
 expect(mock.invoke.mock.calls.every(([command])=>!String(command).includes('cancel')&&!String(command).includes('disable'))).toBe(true);
});
it('keeps independent windows and current session filters; only the target receives source navigation',async()=>{
 mock.rows=[row(1,{message:'old session'}),row(2,{session:'two',source:'Motor',message:'new session'})];mock.session='two';
 const a=render(<Terminal windowKey="main"/>),b=render(<Terminal windowKey="motor"/>);await tick(0);
 expect(within(a.container).getByRole('log')).not.toHaveTextContent('old session');
 fireEvent.change(within(a.container).getByLabelText('日志会话'),{target:{value:''}});expect(within(a.container).getByRole('log')).toHaveTextContent('old session');
 expect(within(b.container).getByRole('log')).not.toHaveTextContent('old session');
 await act(async()=>mock.events.get('terminal-open')?.forEach(fn=>fn({payload:{target:'motor',source:'Motor'}})));
 expect(within(a.container).getByLabelText('日志来源')).toHaveValue('');expect(within(b.container).getByLabelText('日志来源')).toHaveValue('Motor');
 fireEvent.click(within(a.container).getByRole('button',{name:'清屏'}));expect(within(b.container).getByRole('log')).toHaveTextContent('new session');
});
it('does not reopen on historical errors and does not mark filtered errors read',async()=>{
 localStorage.setItem('terminal-open-main','false');mock.rows=Array.from({length:300},(_,i)=>row(i+1,{task:'old',level:'error'}));
 render(<Terminal/>);await tick(50);expect(screen.queryByRole('log')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'展开 Terminal'}));fireEvent.change(screen.getByLabelText('日志级别'),{target:{value:'info'}});
 mock.rows.push(row(301,{level:'error',message:'hidden error'}));await tick();
 expect(screen.getByText(/1 未读错误/)).toBeVisible();expect(screen.getByRole('log')).not.toHaveTextContent('hidden error');
 fireEvent.click(screen.getByText(/1 未读错误/));expect(screen.getByRole('log')).toHaveTextContent('hidden error');
});
it('virtualizes long output, pauses display only, and exports the selected filters',async()=>{
 mock.rows=Array.from({length:2000},(_,i)=>row(i+1));render(<Terminal/>);await tick(200);
 expect(screen.getByRole('log').querySelectorAll('.terminal-row').length).toBeLessThan(50);
 fireEvent.wheel(screen.getByRole('log'),{deltaY:-30});expect(screen.getByLabelText('跟随最新')).not.toBeChecked();
 mock.rows.push(row(2001));await tick();expect(screen.getByText('2001 条')).toBeVisible();
 fireEvent.change(screen.getByLabelText('搜索统一日志'),{target:{value:'line 2001'}});expect(screen.getByRole('log')).toHaveTextContent('line 2001');
 mock.save.mockResolvedValue('/tmp/selected.log');await act(async()=>fireEvent.click(screen.getByRole('button',{name:'导出筛选'})));
 expect(mock.invoke).toHaveBeenCalledWith('terminal_export',expect.objectContaining({path:'/tmp/selected.log',search:'line 2001',session:'one',level:'info+'}));
});
it('exposes retained task actions in the dock, while embedded docks remain hidden',async()=>{
 const base=mock.invoke.getMockImplementation()!;mock.invoke.mockImplementation(async(command,args)=>command==='native_task_snapshot'?{id:1,kind:'trajectory',phase:'running',window:'page-control',command_id:'cmd',message:'执行中'}:base(command,args));
 const main=render(<Terminal/>),embedded=render(<Terminal visible={false} windowKey="control"/>);await tick(0);
 expect(within(embedded.container).queryByRole('region',{name:'全局 Terminal'})).toBeNull();
 fireEvent.click(within(main.container).getByRole('button',{name:'查看当前任务'}));await tick(0);
 expect(within(main.container).getByRole('button',{name:'取消直接轨迹'})).toBeEnabled();
 expect(mock.invoke).not.toHaveBeenCalledWith('native_trajectory_cancel',expect.anything());
});

it('maximizes and restores without changing native visibility or control leases',async()=>{
 render(<Terminal/>);await tick(0);
 fireEvent.click(screen.getByRole('button',{name:'最大化 / 恢复'}));
 expect(screen.getByRole('region',{name:'全局 Terminal'})).toHaveClass('maximized');
 expect(screen.queryByRole('separator')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'收起 Terminal'}));
 expect(screen.getByRole('region',{name:'全局 Terminal'})).not.toHaveClass('maximized');
 fireEvent.click(screen.getByRole('button',{name:'展开 Terminal'}));
 fireEvent.click(screen.getByRole('button',{name:'最大化 / 恢复'}));
 expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow','240');
 expect(mock.invoke.mock.calls.some(([command])=>['workspace_cover','native_trajectory_cancel','native_motor_disable'].includes(command))).toBe(false);
});

it('does not replicate history into embedded docks, then restores it when detached',async()=>{
 mock.rows=Array.from({length:300},(_,i)=>row(i+1));
 const view=render(<Terminal visible={false} windowKey="control"/>);await tick(0);
 expect(mock.invoke).toHaveBeenCalledWith('terminal_read',{after:Number.MAX_SAFE_INTEGER});
 expect(view.container.querySelectorAll('.terminal-row')).toHaveLength(0);
 view.rerender(<Terminal visible windowKey="control"/>);await tick(30);
 expect(screen.getByText('300 条')).toBeVisible();
 expect(mock.invoke).toHaveBeenCalledWith('terminal_read',{after:0});
});

it('preserves search and paused scroll across polling and exports all retained rows independently of filtering',async()=>{
 mock.rows=[row(1,{message:'first INFO'}),row(2,{level:'error',message:'Controller timeout'})];render(<Terminal/>);await tick(0);
 const log=screen.getByRole('log'),search=screen.getByLabelText('搜索统一日志');
 fireEvent.change(search,{target:{value:'TIMEOUT'}});expect(log).toHaveTextContent('Controller timeout');expect(log).not.toHaveTextContent('first INFO');
 fireEvent.wheel(log,{deltaY:-20});log.scrollTop=123;mock.rows.push(row(3,{message:'next timeout'}));await tick();
 expect(search).toHaveValue('TIMEOUT');expect(log.scrollTop).toBe(123);expect(screen.getByLabelText('跟随最新')).not.toBeChecked();
 mock.save.mockResolvedValue('/tmp/all.log');await act(async()=>fireEvent.click(screen.getByRole('button',{name:'导出会话'})));
 expect(mock.invoke).toHaveBeenCalledWith('terminal_export',expect.objectContaining({session:'one',source:null,task:null,search:null,level:null,after:0}));
});
it('reports export errors and skips a cancelled save dialog',async()=>{
 render(<Terminal/>);await tick(0);mock.save.mockResolvedValueOnce(null);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'导出筛选'})));
 expect(mock.invoke.mock.calls.some(([c])=>c==='terminal_export')).toBe(false);
 const base=mock.invoke.getMockImplementation()!;mock.invoke.mockImplementation((c,a)=>c==='terminal_export'?Promise.reject('disk full'):base(c,a));
 mock.save.mockResolvedValue('/tmp/export.log');await act(async()=>fireEvent.click(screen.getByRole('button',{name:'导出筛选'})));
 expect(screen.getByRole('status')).toHaveTextContent('导出失败：disk full');
});
it('downloads the original source without applying display search and does not change follow preferences',async()=>{
 const {defaultProfile}=await import('./types');render(<Terminal profile={defaultProfile}/>);await tick(0);
 fireEvent.change(screen.getByLabelText('日志来源'),{target:{value:'teleop'}});fireEvent.change(screen.getByLabelText('搜索统一日志'),{target:{value:'ERROR'}});fireEvent.click(screen.getByLabelText('跟随最新'));
 mock.save.mockResolvedValue('/tmp/original.log');await act(async()=>fireEvent.click(screen.getByRole('button',{name:'下载源日志'})));
 expect(mock.invoke).toHaveBeenCalledWith('download_control_log',{profile:defaultProfile,source:'teleop',localPath:'/tmp/original.log'});
 expect(screen.getByLabelText('搜索统一日志')).toHaveValue('ERROR');expect(screen.getByLabelText('跟随最新')).not.toBeChecked();
});
it.each(['disconnect','host','session','hidden'] as const)('does not download a stale source after %s while the save dialog is open',async(change)=>{
 const {defaultProfile}=await import('./types');const view=render(<Terminal profile={defaultProfile}/>);await tick(0);
 fireEvent.change(screen.getByLabelText('日志来源'),{target:{value:'teleop'}});
 let finish!:(path:string)=>void;mock.save.mockImplementation(()=>new Promise(resolve=>finish=resolve));fireEvent.click(screen.getByRole('button',{name:'下载源日志'}));
 if(change==='disconnect')view.rerender(<Terminal/>);
 if(change==='host')view.rerender(<Terminal profile={{...defaultProfile,host:'other'}}/>);
 if(change==='session'){mock.session='two';await tick();}
 if(change==='hidden')view.rerender(<Terminal profile={defaultProfile} visible={false}/>);
 await act(async()=>finish('/tmp/old.log'));
 expect(mock.invoke.mock.calls.some(([c])=>c==='download_control_log')).toBe(false);
});
it('serializes reads, reports read errors, and ignores a pending result after unmount',async()=>{
 let fail!:(reason:unknown)=>void;const base=mock.invoke.getMockImplementation()!;
 mock.invoke.mockImplementation((c,a)=>c==='terminal_read'?new Promise((_resolve,reject)=>fail=reject):base(c,a));
 const view=render(<Terminal/>);await tick(5000);expect(mock.invoke.mock.calls.filter(([c])=>c==='terminal_read')).toHaveLength(1);
 await act(async()=>fail('service unavailable'));expect(screen.getByRole('status')).toHaveTextContent('service unavailable');
 let complete!:(page:unknown)=>void;mock.invoke.mockImplementation((c,a)=>c==='terminal_read'?new Promise(resolve=>complete=resolve):base(c,a));await tick(2000);
 view.unmount();await act(async()=>complete({entries:[row(1,{message:'old session output'})],session:'one',sessions:{one:'robot'},latest:1,cursor:1}));
 expect(screen.queryByText('old session output')).toBeNull();
});
it('notification navigation reveals an exact historical entry despite clear, filters and a collapsed dock',async()=>{
 mock.rows=[row(1,{session:'two',source:'Motor',task:'operation-4',level:'error',message:'original mode failure'}),row(2,{session:'two',source:'Task',task:'operation-4',message:'stop acknowledged'})];render(<Terminal/>);await tick(0);
 fireEvent.change(screen.getByLabelText('日志来源'),{target:{value:'Controller'}});fireEvent.change(screen.getByRole('searchbox'),{target:{value:'unrelated'}});fireEvent.click(screen.getByRole('button',{name:'清屏'}));fireEvent.click(screen.getByRole('button',{name:'收起 Terminal'}));
 act(()=>window.dispatchEvent(new CustomEvent('terminal-open',{detail:{target:'main',entry:mock.rows[0]}})));
 expect(screen.getByRole('log')).toHaveTextContent('original mode failure');expect(screen.getByRole('log')).toHaveTextContent('stop acknowledged');expect(screen.getByRole('dialog',{name:'日志详情'})).toHaveTextContent('original mode failure');expect(screen.getByRole('searchbox')).toHaveValue('');expect(screen.getByLabelText('跟随最新')).not.toBeChecked();
});
