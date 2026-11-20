import {act, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {activationPlan,type ManagedController,type ManagerSnapshot} from './controllerManagerLogic';
import {ControllerManagerPanel} from './ControllerManagerPanel';
import {defaultProfile} from './types';
const ipc=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:ipc.invoke,Channel:class{onmessage=()=>{};}}));
const row=(name:string,state='inactive',interfaces=['joint1/position']):ManagedController=>({name,state,typeName:'test/Controller',requiredInterfaces:interfaces,claimedInterfaces:state==='active'?interfaces:[],interfacesKnown:true});
const snapshot=(controllers=[row('new'),row('old','active')]):ManagerSnapshot=>({available:true,owned:true,manager:'/controller_manager',updateRate:100,controllers,hardware:[],fingerprint:'a'.repeat(64)});
beforeEach(()=>{ipc.invoke.mockReset();ipc.invoke.mockResolvedValue(snapshot());});
describe('Controller management',()=>{
 it('uses actual interfaces to expose preemption and rejects conflicts within target',()=>{
  expect(activationPlan(snapshot(),['new'])).toEqual({activate:['new'],deactivate:['old'],error:''});
  expect(activationPlan(snapshot([row('new'),row('other')]),['new','other']).error).toContain('joint1/position');
  const unknown=row('unknown');unknown.interfacesKnown=false;
  expect(activationPlan(snapshot([unknown]),['unknown']).error).toContain('接口');
  expect(activationPlan(snapshot([row('state','inactive',[]),row('effort','inactive',['joint1/effort'])]),['state','effort']).error).toBe('');
 });
 it('never activates on connect and shows all load states',async()=>{
  ipc.invoke.mockResolvedValue(snapshot([row('not_loaded','unloaded'),row('configure_failed','unconfigured'),row('idle'),row('running','active')]));
  render(<ControllerManagerPanel profile={defaultProfile} connected active disabledReason="" presets={<p>preset</p>}/>);
  await screen.findByText('not_loaded');expect(screen.getByText('未配置')).toBeVisible();
  expect(ipc.invoke.mock.calls.every(([command])=>command==='controller_manager_snapshot')).toBe(true);
 });
 it('requires confirmation of the exact conflicting controllers and retains operation history',async()=>{
  const user=userEvent.setup();
  ipc.invoke.mockImplementation(async(command)=>command==='controller_manager_manage'?{ok:true,message:'已核验',detail:''}:snapshot());
  render(<ControllerManagerPanel profile={defaultProfile} connected active disabledReason="" presets={<p>preset</p>}/>);
  await screen.findByText('new');await user.click(screen.getByRole('button',{name:'启用'}));
  expect(screen.getByText('停用：old')).toBeVisible();expect(screen.getByRole('button',{name:'确认执行'})).toBeDisabled();
  await user.click(screen.getByRole('checkbox',{name:'已核对操作对象、现场支撑及运动区域'}));
  await user.click(screen.getByRole('button',{name:'确认执行'}));
  await screen.findByText('已核验');
  expect(ipc.invoke).toHaveBeenCalledWith('controller_manager_manage',expect.objectContaining({request:{action:'switch',activate:['new'],deactivate:['old'],expected:'a'.repeat(64)},confirmed:true}));
  await user.click(screen.getByRole('tab',{name:'模式预设'}));await user.click(screen.getByRole('tab',{name:'Controller 管理'}));expect(screen.getByText('已核验')).toBeVisible();
 });
 it('discards an old robot query after changing connection',async()=>{
  let resolve!:(s:ManagerSnapshot)=>void;
  ipc.invoke.mockImplementationOnce(()=>new Promise(r=>resolve=r));
  const view=render(<ControllerManagerPanel profile={defaultProfile} connected active disabledReason="" presets={null}/>);
  view.rerender(<ControllerManagerPanel profile={{...defaultProfile,host:'another'}} connected={false} active disabledReason="" presets={null}/>);
  await act(async()=>resolve(snapshot()));
  expect(screen.queryByText('new')).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'启动并加载全部'})).toBeDisabled();
 });
 it('does not allow externally owned or active Manager to stop',async()=>{
  ipc.invoke.mockResolvedValue({...snapshot([row('idle')]),owned:false});
  render(<ControllerManagerPanel profile={defaultProfile} connected active disabledReason="" presets={null}/>);
  await waitFor(()=>expect(screen.getByText('idle')).toBeVisible());expect(screen.getByRole('button',{name:'停止 Manager'})).toBeDisabled();
 });
});
