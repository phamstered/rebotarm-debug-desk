import { describe, it, expect } from "vitest";
import { objectBoxLines, objectLabel, parseObjectDetection } from "./objectDetectionLogic";
import type { ObjectDetectionFrame } from "./types";
import { createRgbdSessionState, resetRgbdSession } from "./rgbdPointCloudLogic";
import { expireRgbdSession } from "./rgbdStreamLogic";
const frame: ObjectDetectionFrame = { status: "ok", message: "可见点云包围盒", frame_seq: 1,
  items: [{ id: 1, center: [.1,.2,.3], size: [.04,.05,.06], point_count: 30 }] };
describe("same-frame object metadata", () => {
  it("validates bounded geometry, unique IDs and empty/error consistency", () => {
    expect(parseObjectDetection(frame)).toEqual(frame);
    for (const value of [undefined, { ...frame, frame_seq: NaN }, { ...frame, status: "empty" },
      { ...frame, items: [frame.items[0],frame.items[0]] }, { ...frame, items: Array(21).fill(frame.items[0]) },
      ...[NaN,Infinity,0,-1,.6].map(n => ({...frame, items:[{...frame.items[0],size:[n,.1,.1]}]}))]) {
      expect(parseObjectDetection(value)).toMatchObject({status:"error",items:[]});
    }
    expect(parseObjectDetection({...frame,status:"empty",items:[]})).toMatchObject({status:"empty",items:[]});
  });
  it("renders 12 edges in the same coordinate system as the cloud", () => {
    const vertices=objectBoxLines(frame.items[0]); expect(vertices.length).toBe(72);
    expect([...vertices.slice(0,3)]).toEqual([expect.closeTo(.08),expect.closeTo(.27),expect.closeTo(-.175)]);
    expect(objectLabel(frame.items[0],true)).toBe("物体 #1 · 4.0 × 5.0 × 6.0 cm");
  });
  it("clears boxes atomically with stale cloud and session reset", () => {
    const state={...createRgbdSessionState(),lastFrameAt:100,cloud:{positions:new Float32Array(),colors:new Float32Array(),depths:new Float32Array(),count:0,sourceFrame:"camera",targetFrame:"base_link",stampDiffNs:0,objects:frame}};
    expect(expireRgbdSession(state,599).cloud?.objects).toEqual(frame);
    expect(expireRgbdSession(state,600).cloud).toBeNull();
    expect(resetRgbdSession(state).cloud).toBeNull();
  });
});
