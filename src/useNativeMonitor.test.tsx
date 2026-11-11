import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativeMonitor } from './useNativeMonitor';
import type { MonitorHistoryPage } from './types';
const config={topics:{'/js':'sensor_msgs/msg/JointState'},paused:false,bag_playing:false};
const page:MonitorHistoryPage={epoch:1,reset:0,now_ms:1000,localOffset:0,cursor:1,tail:1,lost:0,skipped:0,config,rows:[]};
afterEach(()=>{cleanup();vi.useRealTimers();});
it('configures capture while hidden, drains only when visible, and rejects late hidden results',async()=>{
  vi.useFakeTimers();let resolve!:(value:MonitorHistoryPage)=>void;
  const bridge={configureMonitor:vi.fn().mockResolvedValue(undefined),monitorHistory:vi.fn(()=>new Promise<MonitorHistoryPage>(yes=>{resolve=yes;}))};
  const onPage=vi.fn();
  const hook=renderHook(({visible})=>useNativeMonitor({bridge,enabled:true,connected:true,visible,config,onPage}),{initialProps:{visible:false}});
  await act(async()=>{});expect(bridge.configureMonitor).toHaveBeenCalledOnce();expect(bridge.monitorHistory).not.toHaveBeenCalled();
  hook.rerender({visible:true});expect(bridge.monitorHistory).toHaveBeenCalledWith(0);
  hook.rerender({visible:false});await act(async()=>{resolve(page);});expect(onPage).not.toHaveBeenCalled();
  await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});expect(bridge.monitorHistory).toHaveBeenCalledOnce();
  hook.rerender({visible:true});await act(async()=>{resolve(page);});expect(onPage).toHaveBeenCalledOnce();
  await act(async()=>{await vi.advanceTimersByTimeAsync(100);});expect(bridge.monitorHistory).toHaveBeenLastCalledWith(1);
});
it('pause is sent to native capture without disconnecting it; reconnect restarts the history cursor',async()=>{
  vi.useFakeTimers();const onPage=vi.fn();
  const bridge={configureMonitor:vi.fn().mockResolvedValue(undefined),monitorHistory:vi.fn().mockResolvedValue(page)};
  const hook=renderHook(({paused,connected})=>useNativeMonitor({bridge,enabled:true,connected,visible:true,config:{...config,paused},onPage}),{initialProps:{paused:false,connected:true}});
  await act(async()=>{});expect(onPage).toHaveBeenCalledOnce();
  hook.rerender({paused:true,connected:true});await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(bridge.configureMonitor).toHaveBeenLastCalledWith({...config,paused:true});expect(onPage).toHaveBeenCalledOnce();
  hook.rerender({paused:false,connected:false});hook.rerender({paused:false,connected:true});await act(async()=>{});
  expect(bridge.monitorHistory).toHaveBeenLastCalledWith(0);
});
it('reports capture errors separately and clears a transient read error on recovery',async()=>{
  vi.useFakeTimers();const bridge={configureMonitor:vi.fn().mockRejectedValue(new Error('type conflict')),monitorHistory:vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(page)};
  const hook=renderHook(()=>useNativeMonitor({bridge,enabled:true,connected:true,visible:true,config,onPage:vi.fn()}));
  await act(async()=>{});expect(hook.result.current).toContain('type conflict');expect(hook.result.current).toContain('temporary');
  await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});expect(hook.result.current).toContain('type conflict');expect(hook.result.current).not.toContain('temporary');
});
