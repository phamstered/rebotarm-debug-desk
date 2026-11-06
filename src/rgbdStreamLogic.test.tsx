import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRgbdStream } from "./rgbdStreamLogic";
import { defaultProfile, type BridgeEnvelope } from "./types";
import type { RgbdFrameMeta } from "./rgbdPointCloudLogic";
function encodeMeta(overrides: Partial<RgbdFrameMeta> = {}): RgbdFrameMeta {
  return {
    op: "rgbd_frame",
    tf_ok: true,
    target_frame: "base_link",
    source_frame: "camera_color_optical_frame",
    stamp_diff_ns: 1_000_000,
    rgb: {
      height: 2,
      width: 2,
      encoding: "rgb8",
      step: 6,
      data_length: 12,
      data_offset: 0,
      is_bigendian: 0,
      header: { frame_id: "camera_color_optical_frame", stamp: { sec: 1, nanosec: 0 } },
    },
    depth: {
      height: 2,
      width: 2,
      encoding: "16UC1",
      step: 4,
      data_length: 8,
      data_offset: 12,
      is_bigendian: 0,
      header: { frame_id: "camera_color_optical_frame", stamp: { sec: 1, nanosec: 500_000 } },
    },
    camera_info: {
      width: 2,
      height: 2,
      k: [100, 0, 1, 0, 100, 1, 0, 0, 1],
    },
    pose: {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    },
    ...overrides,
  };
}

/** 2x2 rgb8 + 16UC1 little-endian depths: 1000mm,0, 2000mm,0 */
function payload2x2(): Uint8Array {
  const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128];
  const depth = [232, 3, 0, 0, 208, 7, 0, 0]; // 1000, 0, 2000, 0 LE
  return new Uint8Array([...rgb, ...depth]);
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(strict = true, detection = false) {
  vi.useFakeTimers();
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frames.set(++next, cb); return next; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  const listeners = new Set<(m: BridgeEnvelope) => void>();
  const bridge = { send: vi.fn(), onMessage: (cb: (m: BridgeEnvelope) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
  const hook = renderHook(({ active, profile, connection }) => useRgbdStream(bridge, active, true, profile, strict, connection, detection), {
    initialProps: { active: true, profile: defaultProfile, connection: 'a' },
  });
  const token = () => bridge.send.mock.calls.filter(([m]) => m.op === 'subscribe_rgbd').at(-1)![0].subscription_id;
  const emit = (patch: Partial<BridgeEnvelope> = {}) => act(() => {
    const message = { ...encodeMeta(), subscription_id: token(), rgbd_payload: payload2x2(), ...patch } as BridgeEnvelope;
    for (const cb of listeners) cb(message);
  });
  const flush = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); for (const cb of callbacks) cb(performance.now()); });
  return { hook, token, emit, flush, bridge, listeners, frames };
}
it('coalesces complete frame groups and expires the last successful receive time at 500ms', async () => {
  const { hook, emit, flush, frames } = setup();
  emit({ pose: { translation: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
  emit({ pose: { translation: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } } });
  expect(frames.size).toBe(1);
  flush();
  expect(hook.result.current[0].cloud?.positions[0]).toBeCloseTo(1.995, 5);
  await act(async () => vi.advanceTimersByTimeAsync(499));
  expect(hook.result.current[0].cloud).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(hook.result.current[0].cloud).toBeNull();
  expect(hook.result.current[0].tfError).toContain('500 ms');
  emit(); flush();
  expect(hook.result.current[0].tfOk).toBe(true);
  hook.unmount();
});
it('hard TF failure clears cloud and pending success immediately; later complete success recovers', () => {
  const { hook, emit, flush, frames } = setup();
  emit(); flush();
  expect(hook.result.current[0].cloud).not.toBeNull();
  emit();
  emit({ tf_ok: false, tf_error: 'real extrapolation failure' });
  expect(frames.size).toBe(0);
  expect(hook.result.current[0].cloud).toBeNull();
  expect(hook.result.current[0].tfError).toBe('real extrapolation failure');
  flush();
  expect(hook.result.current[0].tfOk).toBe(false);
  emit(); flush();
  expect(hook.result.current[0].tfError).toBe('');
  expect(hook.result.current[0].cloud?.count).toBe(2);
  hook.unmount();
});
it('isolates resubscription tokens, queued old callbacks, hidden views and connection changes', () => {
  const { hook, token, emit, flush, listeners, bridge } = setup();
  const oldToken = token(), oldListener = [...listeners][0];
  emit();
  hook.rerender({ active: false, profile: defaultProfile, connection: 'a' });
  expect(hook.result.current[0].cloud).toBeNull();
  expect(bridge.send).toHaveBeenCalledWith({ op: 'unsubscribe_rgbd' });
  act(() => oldListener({ ...encodeMeta(), subscription_id: oldToken, rgbd_payload: payload2x2() } as BridgeEnvelope));
  flush(); expect(hook.result.current[0].cloud).toBeNull();
  hook.rerender({ active: true, profile: defaultProfile, connection: 'b' });
  expect(token()).not.toBe(oldToken);
  emit({ subscription_id: oldToken }); flush();
  expect(hook.result.current[0].cloud).toBeNull();
  emit({ subscription_id: undefined }); flush();
  expect(hook.result.current[0].cloud).toBeNull();
  emit(); flush(); expect(hook.result.current[0].cloud).not.toBeNull();
  hook.unmount();
});
it('supports legacy frames while rejecting a mismatched topic configuration', () => {
  const { hook, emit, flush } = setup(false);
  emit({ subscription_id: undefined, rgb_topic: '/wrong/rgb' }); flush();
  expect(hook.result.current[0].cloud).toBeNull();
  emit({ subscription_id: undefined, rgb_topic: defaultProfile.rgbdRgbTopic }); flush();
  expect(hook.result.current[0].cloud?.count).toBe(2);
  hook.unmount();
});
it('does not refresh expiry with decode failures or a frame waiting beyond the display deadline', async () => {
  const { hook, emit, flush } = setup();
  emit();
  await act(async () => vi.advanceTimersByTimeAsync(501));
  flush();
  expect(hook.result.current[0].cloud).toBeNull();
  emit({ rgbd_payload: new Uint8Array() }); flush();
  expect(hook.result.current[0].tfOk).toBe(false);
  expect(hook.result.current[0].cloud).toBeNull();
  hook.unmount();
});
it('subtracts Jetson source age from the 500ms display lease and rejects invalid or expired source ages', async () => {
  const { hook, emit, flush } = setup();
  emit({ frame_age_ms: 450 }); flush();
  expect(hook.result.current[0].cloud).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(49));
  expect(hook.result.current[0].cloud).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(hook.result.current[0].cloud).toBeNull();
  for (const age of [-1, NaN, Infinity, 500, 5000]) {
    emit({ frame_age_ms: age }); flush();
    expect(hook.result.current[0].cloud).toBeNull();
    expect(hook.result.current[0].tfOk).toBe(false);
  }
  emit({ frame_age_ms: 0 }); flush();
  expect(hook.result.current[0].cloud?.count).toBe(2);
  hook.unmount();
});

it('transports object enablement and replaces boxes with each complete frame or failure', () => {
  const { hook, emit, flush, bridge, token } = setup(true, true);
  expect(bridge.send.mock.calls[0][0]).toMatchObject({detect_objects:true,request_id:token()});
  const objects={status:"ok" as const,message:"可见点云包围盒",frame_seq:1,items:[{id:1,center:[0,0,0] as [number,number,number],size:[.1,.1,.1] as [number,number,number],point_count:30}]};
  emit({objects});flush();expect(hook.result.current[0].cloud?.objects?.items).toHaveLength(1);
  emit({objects:{...objects,status:"empty",items:[],frame_seq:2}});flush();expect(hook.result.current[0].cloud?.objects?.items).toEqual([]);
  emit();flush();expect(hook.result.current[0].cloud?.objects).toMatchObject({status:"error",items:[]});
  emit({objects});flush();emit({op:"error",request_id:token(),error:"Invalid object config"});
  expect(hook.result.current[0].cloud).toBeNull();expect(hook.result.current[0].tfError).toContain("Invalid object config");
  hook.unmount();
});
it('retains the subscription lease when depth expires and clears it on leaving',async()=>{
 const {hook,emit,flush,token}=setup();
 expect(hook.result.current[0].subscriptionId).toBe(token());emit();flush();
 await act(async()=>vi.advanceTimersByTimeAsync(500));
 expect(hook.result.current[0].cloud).toBeNull();expect(hook.result.current[0].subscriptionId).toBe(token());
 hook.rerender({active:false,profile:defaultProfile,connection:'a'});
 expect(hook.result.current[0].subscriptionId).toBeUndefined();hook.unmount();
});
