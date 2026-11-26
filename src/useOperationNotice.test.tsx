import {act,renderHook} from '@testing-library/react';import{expect,it,vi}from'vitest';import{useOperationNotice}from'./useOperationNotice';import{terminalOutput}from'./test/terminal';
it('logs an explicit failure once, suppresses unchanged poll errors and recognizes an identical retry',async()=>{
 const popup=vi.fn();window.addEventListener('operation-failure',popup);const {result}=renderHook(()=>useOperationNotice('Rosbag'));
 act(()=>result.current[1]('disk full',true));expect(popup).toHaveBeenCalledTimes(1);expect(await terminalOutput('Rosbag')).toBe('disk full');
 act(()=>result.current[1]('disk full',true));expect(popup).toHaveBeenCalledTimes(1);
 act(()=>{result.current[1]('');result.current[1]('disk full',true);});expect(popup).toHaveBeenCalledTimes(2);
 expect(popup.mock.calls[0][0].detail.key).not.toBe(popup.mock.calls[1][0].detail.key);
 act(()=>result.current[1]('ordinary output mentions error'));expect(popup).toHaveBeenCalledTimes(2);window.removeEventListener('operation-failure',popup);
});
