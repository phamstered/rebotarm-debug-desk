import {act,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ErrorNotifications} from './ErrorNotifications';
import {reportOperationFailure,terminalPublish,readTerminal,useTerminalMessage} from './terminalLogLogic';
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
const fail=(key:string,message='request rejected')=>act(()=>reportOperationFailure('Motor',message,{key,title:'Motor · 失败'}));
it('shows explicit failures for exactly 3 seconds without taking focus or removing history',async()=>{
 const start=(await readTerminal(Number.MAX_SAFE_INTEGER)).latest;
 render(<><input aria-label="draft"/><ErrorNotifications/></>);screen.getByLabelText('draft').focus();fail('one');
 expect(screen.getByRole('alert')).toHaveTextContent('request rejected');expect(screen.getByLabelText('draft')).toHaveFocus();
 act(()=>vi.advanceTimersByTime(2999));expect(screen.getByRole('alert')).toBeVisible();act(()=>vi.advanceTimersByTime(1));expect(screen.queryByRole('alert')).toBeNull();
 expect((await readTerminal(start)).entries).toHaveLength(1);
});
it('never toasts raw error logs or historical reads and does not replay on remount',async()=>{
 terminalPublish({source:'Motor',level:'error',message:'historical error'});const v=render(<ErrorNotifications/>);await readTerminal(0);expect(screen.queryByRole('alert')).toBeNull();
 v.unmount();render(<ErrorNotifications/>);expect(screen.queryByRole('alert')).toBeNull();
});
it('merges transaction errors without extending lifetime, but a retry is a new event',()=>{
 render(<ErrorNotifications/>);fail('operation-1');act(()=>vi.advanceTimersByTime(2000));fail('operation-1','second detail');expect(screen.getAllByRole('alert')).toHaveLength(1);
 act(()=>vi.advanceTimersByTime(1000));expect(screen.queryByRole('alert')).toBeNull();fail('operation-1');expect(screen.queryByRole('alert')).toBeNull();fail('operation-2');expect(screen.getByRole('alert')).toBeVisible();
});
it('caps simultaneous cards at three, expires independently and supports early close',()=>{
 render(<ErrorNotifications/>);fail('a','first');act(()=>vi.advanceTimersByTime(500));fail('b','second');fail('c','third');fail('d','fourth');expect(screen.getAllByRole('alert')).toHaveLength(3);expect(screen.queryByText('first')).toBeNull();
 fireEvent.click(screen.getAllByRole('button',{name:'关闭错误提示'})[0]);expect(screen.getAllByRole('alert')).toHaveLength(2);
 act(()=>vi.advanceTimersByTime(3000));expect(screen.queryByRole('alert')).toBeNull();
});
it('routes log navigation with exact record and session, and does not append a duplicate',async()=>{
 const handler=vi.fn();window.addEventListener('terminal-open',handler);
 const start=(await readTerminal(Number.MAX_SAFE_INTEGER)).latest;render(<ErrorNotifications target="motor"/>);fail('navigation');fireEvent.click(screen.getByRole('button',{name:'查看日志 →'}));
 expect(handler.mock.calls[0][0].detail).toMatchObject({target:'motor',entry:{id:start+1,source:'Motor',session:'local'}});expect((await readTerminal(start)).entries).toHaveLength(1);expect(screen.queryByRole('alert')).toBeNull();window.removeEventListener('terminal-open',handler);
});
function Status({message}:{message:string}){useTerminalMessage('Controller',message,'error');return null;}
it('logs initial state silently, only notifies explicit new error transitions and tolerates repeated polling',()=>{
 const v=render(<><Status message="existing failure"/><ErrorNotifications/></>);expect(screen.queryByRole('alert')).toBeNull();
 v.rerender(<><Status message=""/><ErrorNotifications/></>);v.rerender(<><Status message="new failure"/><ErrorNotifications/></>);expect(screen.getAllByRole('alert')).toHaveLength(1);
 v.rerender(<><Status message="new failure"/><ErrorNotifications/></>);expect(screen.getAllByRole('alert')).toHaveLength(1);
});
