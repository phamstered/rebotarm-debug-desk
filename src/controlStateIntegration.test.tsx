import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { StatusPage } from './StatusPage';
import { defaultProfile } from './types';
import { ControllerManagerPanel } from './ControllerManagerPanel';
import userEvent from '@testing-library/user-event';
const state=vi.hoisted(()=>({manager: null as any, task: null as any}));
vi.mock('./controllerManagerLogic',()=>({useControllerManager:()=>state.manager}));
vi.mock('./nativeTaskSnapshotLogic',()=>({useNativeTaskSnapshot:()=>({task:state.task,error:'',loaded:true})}));
vi.mock('./nativeWorkspaceLogic',()=>({nativeDesktop:()=>true}));
const props={controlView:true,renderControl:(node:any)=>node,stage:'connected',sshOk:true,bridgeUp:true,localPort:18765,profile:defaultProfile,hello:null,agentStatus:null,agentError:'',agentChecked:false,hardwareStatus:{mode:3,mode_name:'DISABLE',fault_code:0,last_command_sequence:1},jointState:{name:['j1'],position:[0]},jointStateSample:undefined,lastKnownDomainId:0,rosControl:{manager:'/controller_manager',fresh:true,available:true,controllers:[{name:'arm_teleop_controller',state:'active',typeName:'test'}],message:''}};
it('never offers rebuilding Teleop while Manager observations conflict or a task remains owned',()=>{
 state.manager={snapshot:{manager:'/controller_manager',available:false,controllers:[]},fresh:true,refresh:vi.fn()};state.task={kind:'arm_mode',phase:'stopping',message:'remote pending'};
 const view=render(<StatusPage {...props}/>);
 expect(screen.getByTestId('current-control-mode')).toHaveTextContent('状态不一致');
 expect(screen.queryByRole('button',{name:'重建控制会话'})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'等待状态核验'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'直接解除电机输出'})).toBeVisible();
 state.manager={snapshot:{manager:'/controller_manager',available:true,controllers:props.rosControl.controllers},fresh:true,refresh:vi.fn()};
 view.rerender(<StatusPage {...props}/>);
 expect(screen.getByRole('button',{name:'等待状态核验'})).toBeDisabled();
 state.task=null;view.rerender(<StatusPage {...props}/>);
 expect(screen.getByRole('button',{name:'重建控制会话'})).toBeEnabled();
});

it('shares one help/log entry across tabs and shows an unresolved task once without hiding DISABLE', async () => {
 const user = userEvent.setup(), action = vi.fn();
 state.manager={snapshot:{manager:'/controller_manager',available:true,owned:true,updateRate:100,controllers:[],hardware:[],fingerprint:'test'},fresh:true,refresh:vi.fn(),busy:false,refreshing:false,syncing:false,error:''};
 state.task={kind:'arm_mode',phase:'stopping',message:'remote pending'};
 render(<StatusPage {...props} rosControl={{...props.rosControl,controllers:[]}} onQuickAction={action}
   renderControl={(presets,manager,reason)=><ControllerManagerPanel profile={defaultProfile} connected active disabledReason={reason} manager={manager} presets={presets}/>}/>);
 expect(screen.getAllByText(/已有共享控制任务尚未结束/)).toHaveLength(1);
 expect(screen.getAllByRole('button',{name:'查看日志'})).toHaveLength(1);
 expect(screen.getByText(/默认全部加载并配置为 inactive/)).not.toBeVisible();
 await user.click(screen.getByText('操作说明'));
 expect(screen.getByText(/默认全部加载并配置为 inactive/)).toBeVisible();
 expect(screen.getByRole('button',{name:'补加载 / 重试未配置项'})).toBeDisabled();
 await user.click(screen.getByRole('button',{name:'前往停止操作'}));
 expect(screen.getByRole('tab',{name:'模式预设'})).toHaveAttribute('aria-selected','true');
 expect(screen.getAllByText(/已有共享控制任务尚未结束/)).toHaveLength(1);
 expect(screen.getAllByRole('button',{name:'查看日志'})).toHaveLength(1);
 expect(screen.getByRole('button',{name:'等待状态核验'})).toBeDisabled();
 await user.click(screen.getByRole('button',{name:'直接解除电机输出'}));
 expect(screen.getByRole('button',{name:'确认 DISABLE 并停止'})).toBeDisabled();
 expect(action).not.toHaveBeenCalled();
 await user.click(screen.getByLabelText('机械臂已支撑，可以解除输出'));
 await user.click(screen.getByRole('button',{name:'确认 DISABLE 并停止'}));
 expect(action).toHaveBeenCalledExactlyOnceWith('disable-stop');
});
