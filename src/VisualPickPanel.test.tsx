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
it('retains the selected UUID across handoff, blocks unverified RGB and releases explicitly',async()=>{
 const t={target_id:'550e8400-e29b-41d4-a716-446655440000',object_id:1,sequence:3,generation:2,mode:'rgbd',identity_valid:true,metric_ready:true,plane_verified:false,confidence:.95,age_ms:10,camera_z_m:.3,depth_valid_fraction:.9,geometry_source:'depth_verified_surface',message:'一致跟踪',source_frame:'color_optical',target_frame:'base_link',stamp_ns:1000000000,roi:[10,10,30,30],box};
 const listeners=new Set<(m:any)=>void>();
 const bridge={request:vi.fn(async(m:any)=>m.op==='visual_pick_preview'?{...preview,tracking:t}:m.op==='visual_target_release'?{op:'visual_target_released'}:{op:'visual_pick_state',command_id:'',pick_phase:'idle',message:'',busy:false}),send:vi.fn(),onMessage:(cb:any)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as unknown as BridgeClient;
 const clear=vi.fn();const view=render(<VisualPickPanel bridge={bridge} token='a' selected={box} active onPreview={vi.fn()} onBusy={vi.fn()} onClear={clear}/>);
 await screen.findByText(/550e8400.*RGBD/);
 await act(async()=>{for(const cb of listeners)cb({op:'visual_target_frame',subscription_id:'a',tracking:{...t,sequence:4,mode:'rgb',metric_ready:false,message:'固定顶面未核验'}});await new Promise(r=>requestAnimationFrame(r));});
 expect(screen.getByText(/550e8400.*RGB ·/)).toBeVisible();
 expect(screen.getByRole('button',{name:'接近、抓取并抬升'})).toBeDisabled();
 expect(screen.getByText('已选物体 #1')).toBeVisible();
 await act(async()=>{for(const cb of listeners)cb({op:'visual_target_frame',subscription_id:'old',tracking:{...t,target_id:'other'}});await new Promise(r=>requestAnimationFrame(r));});
 expect(screen.getByText(/550e8400.*RGB ·/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'清除选择'}));
 await waitFor(()=>expect(bridge.request).toHaveBeenCalledWith({op:'visual_target_release',subscription_id:'a',target_id:t.target_id},2500));
 expect(clear).toHaveBeenCalledOnce();view.unmount();
});
it('expires RGB identity and rejects a later automatic recovery of the same binding',async()=>{
 const t={target_id:'550e8400-e29b-41d4-a716-446655440000',object_id:1,sequence:3,generation:2,mode:'rgbd',identity_valid:true,metric_ready:true,plane_verified:false,confidence:.95,age_ms:490,camera_z_m:.3,depth_valid_fraction:.9,geometry_source:'depth_verified_surface',message:'一致跟踪',source_frame:'color_optical',target_frame:'base_link',stamp_ns:1000000000,roi:[10,10,30,30],box};
 const listeners=new Set<(m:any)=>void>();
 const bridge={request:vi.fn(async(m:any)=>m.op==='visual_pick_preview'?{...preview,tracking:t}:{op:'visual_pick_state',command_id:'',pick_phase:'idle',message:'',busy:false}),send:vi.fn(),onMessage:(cb:any)=>{listeners.add(cb);return()=>listeners.delete(cb);}} as unknown as BridgeClient;
 const view=render(<VisualPickPanel bridge={bridge} token='a' selected={box} active onPreview={vi.fn()} onBusy={vi.fn()} onClear={vi.fn()}/>);
 await screen.findByText(/550e8400.*RGBD/);
 await act(async()=>{for(const cb of listeners)cb({op:'visual_target_frame',subscription_id:'a',tracking:t});await new Promise(r=>setTimeout(r,50));});
 expect(screen.getByText(/550e8400.*身份待确认/)).toBeVisible();
 await act(async()=>{for(const cb of listeners)cb({op:'visual_target_frame',subscription_id:'a',tracking:{...t,sequence:4,age_ms:0}});await new Promise(r=>requestAnimationFrame(r));});
 expect(screen.getByText(/550e8400.*身份待确认/)).toBeVisible();view.unmount();
});
it('cannot clear a newer selection when an earlier release completes late',async()=>{
 const t={target_id:'550e8400-e29b-41d4-a716-446655440000',object_id:1,sequence:3,generation:2,mode:'rgbd',identity_valid:true,metric_ready:true,plane_verified:false,confidence:.95,age_ms:10,camera_z_m:.3,depth_valid_fraction:.9,geometry_source:'depth_verified_surface',message:'一致跟踪',source_frame:'color_optical',target_frame:'base_link',stamp_ns:1000000000,roi:[10,10,30,30],box};
 let release!:(v:unknown)=>void;
 const bridge={request:vi.fn((m:any)=>m.op==='visual_target_release'?new Promise(r=>{release=r}):Promise.resolve(m.op==='visual_pick_preview'?{...preview,object_id:m.object_id,tracking:{...t,object_id:m.object_id,box:{...box,id:m.object_id},target_id:m.object_id===1?t.target_id:'550e8400-e29b-41d4-a716-446655440002'}}:{op:'visual_pick_state',command_id:'',pick_phase:'idle',message:'',busy:false})),send:vi.fn(),onMessage:()=>()=>{}} as unknown as BridgeClient;
 const p={bridge,token:'a',selected:box,active:true,onPreview:vi.fn(),onBusy:vi.fn(),onClear:vi.fn()};
 const view=render(<VisualPickPanel {...p}/>);await screen.findByText(/550e8400.*RGBD/);
 fireEvent.click(screen.getByRole('button',{name:'清除选择'}));
 expect(screen.getByRole('button',{name:'清除选择'})).toBeDisabled();
 view.rerender(<VisualPickPanel {...p} selected={{...box,id:2}}/>);await screen.findByText('已选物体 #2');
 await act(async()=>release({op:'visual_target_released'}));
 expect(p.onClear).not.toHaveBeenCalled();expect(screen.getByText('已选物体 #2')).toBeVisible();
 view.unmount();
});
