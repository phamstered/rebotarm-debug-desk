import { describe, expect, it } from 'vitest';
import { operationFailureSummary, filterTerminal, formatTerminal, logLevel, terminalPublish, readTerminal, retainTerminal, type TerminalEntry } from './terminalLogLogic';
const entry = (id:number, patch:Partial<TerminalEntry>={}):TerminalEntry => ({id,time:id,session:'one',host:'jetson',source:'Controller',task:'switch-1',message:'已请求 DISABLE',level:'info',...patch});
describe('unified Terminal history',()=>{
 it('marks producer truncation without splitting UTF-16 surrogate pairs',async()=>{const after=(await readTerminal(0)).latest;terminalPublish({source:'System',level:'info',message:'x'.repeat(15999)+'😀end'});const message=(await readTerminal(after)).entries[0].message;expect(message).toBe('x'.repeat(15999)+'…[前端截断]');});
 it('does not turn a zero firmware error code into a reported failure',()=>{expect(logLevel('固件读回成功 error=0')).toBe('info');expect(logLevel('ERROR command failed')).toBe('error');});
 it('combines session, task, source, level and case-insensitive metadata search',()=>{
  const rows=[entry(1),entry(2,{session:'two'}),entry(3,{level:'error'}),entry(4,{task:'switch-2'}),entry(5,{level:'debug'})];
  const filter={session:'one',source:'Controller',level:'info+',task:'switch-1',search:'JETSON',after:0};
  expect(filterTerminal(rows,filter).map(e=>e.id)).toEqual([1,3]);
  expect(filterTerminal(rows,{...filter,level:'error',after:1}).map(e=>e.id)).toEqual([3]);
  expect(filterTerminal(rows,{...filter,search:'absent'})).toEqual([]);
  expect(formatTerminal(rows[0])).toBe('1 [INFO] [jetson] [Controller] [switch-1] 已请求 DISABLE');
 });
 it('bounds retained rows and bytes independently without changing sequence or older consumers',()=>{
  const rows=Array.from({length:20002},(_,i)=>entry(i+1));const copy=[...rows];
  expect(retainTerminal(rows)).toHaveLength(20000);expect(retainTerminal(rows)[0].id).toBe(3);
  expect(copy).toHaveLength(20002);
  const large=Array.from({length:4000},(_,i)=>entry(i,{message:'中'.repeat(4000)}));
  const kept=retainTerminal(large);
  expect(kept.length).toBeLessThan(2000);expect(kept.at(-1)?.id).toBe(3999);
  expect(new TextEncoder().encode(kept.map(e=>JSON.stringify(e)).join('')).length).toBeLessThanOrEqual(20*1024*1024);
 });
});

it('keeps only a bounded current reason beside connection controls while the original output is retained',async()=>{
 const message='SSH handshake failed\nTraceback: remote command detail';
 expect(operationFailureSummary(message)).toBe('SSH handshake failed');
 expect(operationFailureSummary('😀'.repeat(181))).toBe('😀'.repeat(180)+'…');
 const cursor=(await readTerminal(0)).latest;
 terminalPublish({source:'Connection',level:'error',message});
 expect((await readTerminal(cursor)).entries[0].message).toBe(message);
});
