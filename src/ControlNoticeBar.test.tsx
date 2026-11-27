import {render,screen} from '@testing-library/react';
import {expect,it} from 'vitest';
import {ControlNoticeBar} from './ControlNoticeBar';
it('deduplicates current notices and removes resolved state without retaining history',()=>{
 const view=render(<ControlNoticeBar messages={['等待停止确认','等待停止确认','',null]}/>);
 expect(screen.getAllByText('等待停止确认')).toHaveLength(1);
 expect(screen.getByRole('status',{name:'控制提示'})).toBeVisible();
 view.rerender(<ControlNoticeBar messages={['操作进行中']}/>);
 expect(screen.queryByText('等待停止确认')).not.toBeInTheDocument();
 view.rerender(<ControlNoticeBar messages={[]}/>);
 expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
