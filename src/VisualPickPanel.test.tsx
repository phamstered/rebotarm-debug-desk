import {act,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {VisualPickPanel} from './VisualPickPanel';
import {parseVisualPickPreview,parseVisualPickState} from './visualPickLogic';
import type {BridgeClient} from './bridge';
import type {PositionMotionControls} from './positionMotionLogic';
const box={id:1,center:[.2,0,.05] as [number,number,number],size:[.05,.05,.05] as [number,number,number],point_count:40};
const pose={position:[.2,0,.07],orientation:[0,0,0,1]};
const preview={op:'visual_pick_preview',subscription_id:'a',object_id:1,frame_seq:3,calibrated:false,execution_ready:false,grasp:pose,pregrasp:pose,opening_m:.03,message:'尚未标定，仅预览'};
function setup(){
 const bridge={request:vi.fn(async (m:{op:string})=>m.op==='visual_pick_preview'?preview:{op:'visual_pick_state',command_id:'',pick_phase:'idle',message:'',busy:false}),send:vi.fn(),onMessage:vi.fn(()=>()=>{})} as unknown as BridgeClient;
 const onPreview=vi.fn(),onBusy=vi.fn();
 const motion={armed:true,setArmed:vi.fn(),reason:'',tcpPoseReason:'',gripper:{available:true,fresh:true}} as unknown as PositionMotionControls;
 const props={bridge,token:'a',selected:box,active:true,motion,onPreview,onBusy,onClear:vi.fn()};
 return {bridge,props,...render(<VisualPickPanel {...props}/>)};
}
it('selection generates only a preview and calibration blocks execution',async()=>{
 const {bridge}=setup();await screen.findByText("尚未标定，仅预览");
 expect(screen.getByRole('button',{name:'接近、抓取并抬升'})).toBeDisabled();
 expect(vi.mocked(bridge.request).mock.calls.every(([m])=>m.op==='visual_pick_preview'||m.op==='visual_pick_status')).toBe(true);
 expect(bridge.send).not.toHaveBeenCalled();
});
it('clears a stale target preview and rejects late responses from previous selection',async()=>{
 const {props,rerender}=setup();await screen.findByText(/候选抓取中心/);
 rerender(<VisualPickPanel {...props} selected={null}/>);await waitFor(()=>expect(props.onPreview).toHaveBeenLastCalledWith(null));
 expect(screen.queryByText(/候选抓取中心/)).toBeNull();
});
it('validates geometry, frame lease and state namespaces',()=>{
 expect(parseVisualPickPreview(preview as never,'a',1).object_id).toBe(1);
 expect(()=>parseVisualPickPreview(preview as never,'b',1)).toThrow();
 expect(()=>parseVisualPickPreview({...preview,grasp:{...pose,position:[NaN,0,0]}} as never,'a',1)).toThrow();
 expect(()=>parseVisualPickState({op:'visual_pick_state',phase:1,busy:false} as never)).toThrow();
 expect(parseVisualPickState({op:'visual_pick_state',command_id:'x',pick_phase:'holding',message:'未确认夹持',busy:false})).toMatchObject({phase:'holding',busy:false});
});
it('does not apply preview responses after a lease change',async()=>{
 let resolve!:(v:unknown)=>void;
 const bridge={request:vi.fn((m:{op:string})=>m.op==='visual_pick_preview'?new Promise(r=>{resolve=r}):Promise.resolve({op:'visual_pick_state',command_id:'',pick_phase:'idle',message:'',busy:false})),send:vi.fn(),onMessage:()=>()=>{}} as unknown as BridgeClient;
 const onPreview=vi.fn();const p={bridge,token:'a',selected:box,active:true,onPreview,onBusy:vi.fn(),onClear:vi.fn()};
 const view=render(<VisualPickPanel {...p}/>);view.rerender(<VisualPickPanel {...p} token='b' selected={null}/>);
 await act(async()=>resolve(preview));expect(onPreview).not.toHaveBeenCalledWith(expect.objectContaining({object_id:1}));
});
it('starts only after explicit click and cancels its own task on leaving the view',async()=>{
 const p={...preview,calibrated:true,execution_ready:true,message:'候选姿态'};
 const bridge={request:vi.fn(async(m:{op:string;command_id?:string})=>m.op==='visual_pick_preview'?p:m.op==='visual_pick_start'?{op:'visual_pick_state',command_id:m.command_id,pick_phase:'validating',busy:true,message:'校验'}:{op:'visual_pick_state',command_id:'',pick_phase:'idle',message:'',busy:false}),send:vi.fn(),onMessage:()=>()=>{}} as unknown as BridgeClient;
 const motion={armed:true,setArmed:vi.fn(),reason:'',tcpPoseReason:'',gripper:{available:true,fresh:true}} as unknown as PositionMotionControls;
 const props={bridge,motion,token:'a',selected:box,active:true,onPreview:vi.fn(),onBusy:vi.fn(),onClear:vi.fn()};
 const view=render(<VisualPickPanel {...props}/>);await screen.findByText(/候选抓取中心/);
 expect(vi.mocked(bridge.request).mock.calls.filter(([m])=>m.op==='visual_pick_start')).toHaveLength(0);
 fireEvent.click(screen.getByRole('button',{name:'接近、抓取并抬升'}));
 await waitFor(()=>expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({op:'visual_pick_start',object_id:1,subscription_id:'a',preview_frame_seq:3,confirmation:'ARMED'}),5000));
 view.rerender(<VisualPickPanel {...props} active={false}/>);expect(bridge.send).toHaveBeenCalledWith({op:'visual_pick_cancel'});
});
