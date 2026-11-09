import {expect,it} from 'vitest';
import {acceptRgbTarget,parseRgbTarget} from './visualPickLogic';
import {decodeBridgeEnvelope} from './bridge';
import type {RgbTargetState} from './types';
export const target:RgbTargetState={
 target_id:'550e8400-e29b-41d4-a716-446655440000',object_id:1,sequence:3,generation:2,
 mode:'rgbd',identity_valid:true,metric_ready:true,plane_verified:false,confidence:.95,age_ms:10,
 camera_z_m:.3,depth_valid_fraction:.9,geometry_source:'depth_verified_surface',message:'一致跟踪',
 source_frame:'color_optical',target_frame:'base_link',stamp_ns:1000000000,roi:[10,10,30,30],
 box:{id:1,center:[.2,0,.025],size:[.05,.05,.05],point_count:100},
};
it('requires verified geometry for metric RGB observations and bounded finite data',()=>{
 expect(parseRgbTarget(target)).toBe(target);
 expect(()=>parseRgbTarget({...target,mode:'rgb'})).toThrow();
 expect(parseRgbTarget({...target,mode:'rgb',metric_ready:false}).identity_valid).toBe(true);
 expect(()=>parseRgbTarget({...target,confidence:NaN})).toThrow();
 expect(()=>parseRgbTarget({...target,roi:[0,0,-1,2]})).toThrow();
 expect(()=>parseRgbTarget({...target,mode:'uncertain'})).toThrow();
});
it('preserves UUID across RGBD/RGB but rejects other targets, old epochs and recovery after ambiguity',()=>{
 const rgb={...target,sequence:4,mode:'rgb' as const,metric_ready:false};
 expect(acceptRgbTarget(target,rgb,target.target_id,1)).toBe(true);
 expect(acceptRgbTarget(target,{...rgb,target_id:'other'},target.target_id,1)).toBe(false);
 expect(acceptRgbTarget(target,{...rgb,generation:3},target.target_id,1)).toBe(false);
 expect(acceptRgbTarget(target,{...rgb,sequence:2},target.target_id,1)).toBe(false);
 expect(acceptRgbTarget({...target,mode:'uncertain',identity_valid:false,metric_ready:false},rgb,target.target_id,1)).toBe(false);
});
it('decodes independent binary RGB target frames and rejects truncated or mismatched envelopes',()=>{
 const metadata=new TextEncoder().encode(JSON.stringify({op:'visual_target_frame',tracking:{...target,diagnostic:'depth_status=missing',handoff_reason:'depth_unavailable'},subscription_id:'lease',data_length:3}));
 const bytes=new Uint8Array(8+metadata.length+3);bytes.set([82,67,84,49]);new DataView(bytes.buffer).setUint32(4,metadata.length,false);bytes.set(metadata,8);bytes.set([10,20,30],8+metadata.length);
 const decoded=decodeBridgeEnvelope(bytes.buffer);expect(decoded.tracking?.target_id).toBe(target.target_id);expect(decoded.tracking?.diagnostic).toBe("depth_status=missing");expect(decoded.tracking?.handoff_reason).toBe("depth_unavailable");expect([...decoded.target_rgb_payload!]).toEqual([10,20,30]);
 expect(()=>decodeBridgeEnvelope(bytes.slice(0,-1).buffer)).toThrow();
});

it('keeps waiting/recovering non-executable and requires fresh multi-frame evidence after a local lapse',()=>{
 const waiting={...target,mode:'waiting' as const,identity_valid:false,metric_ready:false};
 expect(parseRgbTarget(waiting)).toBe(waiting);
 expect(()=>parseRgbTarget({...waiting,identity_valid:true})).toThrow();
 expect(()=>parseRgbTarget({...target,mode:'recovering'})).toThrow();
 expect(acceptRgbTarget(waiting,{...target,sequence:4},target.target_id,1)).toBe(false);
 expect(acceptRgbTarget(waiting,{...target,sequence:6},target.target_id,1)).toBe(false);
 expect(acceptRgbTarget(waiting,{...target,sequence:6,stamp_ns:target.stamp_ns+100000000},target.target_id,1)).toBe(true);
});
