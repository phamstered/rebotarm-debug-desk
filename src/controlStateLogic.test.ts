import { describe, expect, it } from 'vitest';
import { reconcileControlState, controlTaskReason } from './controlStateLogic';
import type { ManagerSnapshot } from './controllerManagerLogic';
import type { RosControlStatus, NativeTaskSnapshot } from './types';
const row = {name:'arm_teleop_controller',state:'active',typeName:'test',requiredInterfaces:[],claimedInterfaces:[],interfacesKnown:true};
const manager:ManagerSnapshot={manager:'/controller_manager',available:true,owned:true,updateRate:100,controllers:[row],hardware:[],fingerprint:'x'};
const ros:RosControlStatus={manager:manager.manager,available:true,fresh:true,controllers:[row],message:''};
describe('control observation state machine',()=>{
 it('does not infer a mode from missing or expired observations',()=>{
  expect(reconcileControlState(null,false,ros).state).toBe('unknown');
  expect(reconcileControlState(manager,false,ros).modeKnown).toBe(false);
  expect(reconcileControlState(manager,true,{...ros,fresh:false}).modeKnown).toBe(false);
 });
 it('detects the screenshot contradiction and waits for convergence',()=>{
  const absent={...manager,available:false,controllers:[]};
  expect(reconcileControlState(absent,true,ros).state).toBe('conflict');
  expect(reconcileControlState(absent,true,{...ros,available:false,fresh:false}).state).toBe('offline');
  expect(reconcileControlState(manager,true,ros).state).toBe('ready');
 });
 it('compares active sets independent of ordering and detects switches and different managers',()=>{
  expect(reconcileControlState(manager,true,{...ros,controllers:[]}).state).toBe('conflict');
  expect(reconcileControlState(manager,true,{...ros,manager:'/other'}).state).toBe('conflict');
  const other={...row,name:'gravity_compensation_controller'};
  expect(reconcileControlState({...manager,controllers:[row,other]},true,{...ros,controllers:[other,row]}).state).toBe('ready');
 });
 it.each(['submitting','running','stopping','uncertain'] as const)('keeps ownership blocking through %s',phase=>{
  expect(controlTaskReason({phase} as NativeTaskSnapshot)).toContain('新操作暂不可用');
  expect(controlTaskReason(null)).toBe('');
 });
});
