import { describe, expect, it } from "vitest";
import {
  LatestFrameGroupQueue,
  applyRgbdFrameToSession,
  backProjectPixel,
  buildColoredPointCloud,
  choosePreviewSize,
  cloudPositionsToScene,
  createRgbdSessionState,
  depthMetersFromBytes,
  poseToMat4,
  quatToMat4,
  readRgb888,
  resetRgbdSession,
  scaleIntrinsics,
  stampsWithinTolerance,
  type RgbdFrameMeta,
} from "./rgbdPointCloudLogic";
import { applyPoint } from "./kinematicsLogic";

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

describe("rgbd depth decode", () => {
  it("decodes 16UC1 mm and treats 0 as invalid", () => {
    const bytes = new Uint8Array([232, 3, 0, 0]); // 1000, 0
    expect(depthMetersFromBytes("16UC1", bytes, 0, false)).toBeCloseTo(1.0);
    expect(depthMetersFromBytes("16UC1", bytes, 2, false)).toBeNull();
  });

  it("decodes 32FC1 meters and rejects non-finite / non-positive", () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setFloat32(0, 1.5, true);
    view.setFloat32(4, Number.NaN, true);
    view.setFloat32(8, -0.1, true);
    const bytes = new Uint8Array(buf);
    expect(depthMetersFromBytes("32FC1", bytes, 0, false)).toBeCloseTo(1.5);
    expect(depthMetersFromBytes("32FC1", bytes, 4, false)).toBeNull();
    expect(depthMetersFromBytes("32FC1", bytes, 8, false)).toBeNull();
  });

  it("respects big-endian 16UC1", () => {
    const bytes = new Uint8Array([0x03, 0xe8]); // 1000 BE
    expect(depthMetersFromBytes("16UC1", bytes, 0, true)).toBeCloseTo(1.0);
  });
});

describe("rgbd intrinsics / pairing", () => {
  it("scales CameraInfo K with preview resize", () => {
    const k = scaleIntrinsics([200, 0, 100, 0, 200, 50, 0, 0, 1], 640, 480, 320, 240);
    expect(k[0]).toBeCloseTo(100);
    expect(k[2]).toBeCloseTo(50);
    expect(k[4]).toBeCloseTo(100);
    expect(k[5]).toBeCloseTo(25);
  });

  it("chooses preview size under max bounds", () => {
    expect(choosePreviewSize(640, 480, 320, 240)).toEqual({ width: 320, height: 240 });
    expect(choosePreviewSize(160, 120, 320, 240)).toEqual({ width: 160, height: 120 });
  });

  it("enforces stamp tolerance", () => {
    expect(stampsWithinTolerance({ sec: 1, nanosec: 0 }, { sec: 1, nanosec: 40_000_000 }).ok).toBe(true);
    expect(stampsWithinTolerance({ sec: 1, nanosec: 0 }, { sec: 1, nanosec: 60_000_000 }).ok).toBe(false);
  });
});

describe("back-project and pose", () => {
  it("back-projects along optical Z", () => {
    expect(backProjectPixel(1, 1, 2, 100, 100, 1, 1)).toEqual([0, 0, 2]);
  });

  it("keeps a fixed optical point stable in base_link when pose matches the frame stamp", () => {
    // Camera at (1,0,0) looking along +Z optical with identity rotation.
    const pose = poseToMat4({
      translation: { x: 1, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const optical = backProjectPixel(1, 1, 2, 100, 100, 1, 1);
    const base = applyPoint(pose, optical);
    expect(base[0]).toBeCloseTo(1);
    expect(base[1]).toBeCloseTo(0);
    expect(base[2]).toBeCloseTo(2);

    // Wrong "latest" pose would place the same point elsewhere — regression guard.
    const wrong = poseToMat4({
      translation: { x: 1.5, y: 0.2, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    const drifted = applyPoint(wrong, optical);
    expect(Math.hypot(drifted[0] - base[0], drifted[1] - base[1], drifted[2] - base[2])).toBeGreaterThan(0.4);
  });

  it("builds a colored cloud skipping invalid depth", () => {
    const cloud = buildColoredPointCloud(encodeMeta(), payload2x2());
    expect(cloud.count).toBe(2);
    expect(cloud.colors[0]).toBeCloseTo(1);
    expect(cloud.depths[0]).toBeCloseTo(1);
    expect(cloud.depths[1]).toBeCloseTo(2);
  });

  it("maps URDF Z-up cloud into scene Y-up", () => {
    const scene = cloudPositionsToScene(new Float32Array([1, 2, 3]));
    expect([...scene]).toEqual([1, 3, -2]);
  });
});

describe("session / queue isolation", () => {
  it("drops previous complete groups in LatestFrameGroupQueue", () => {
    const q = new LatestFrameGroupQueue<number>();
    q.push(1);
    q.push(2);
    expect(q.droppedCount).toBe(1);
    expect(q.take()).toBe(2);
    expect(q.take()).toBeNull();
  });

  it("marks stale on TF failure and keeps prior cloud", () => {
    let state = createRgbdSessionState(1);
    const cloud = buildColoredPointCloud(encodeMeta(), payload2x2());
    state = { ...state, cloud, lastFrameAt: 1000 };
    state = applyRgbdFrameToSession(state, 1, { op: "rgbd_frame", tf_ok: false, tf_error: "lookup failed", rgb: encodeMeta().rgb, depth: encodeMeta().depth, camera_info: encodeMeta().camera_info }, new Uint8Array());
    expect(state.stale).toBe(true);
    expect(state.tfOk).toBe(false);
    expect(state.cloud).toBe(cloud);
  });

  it("rejects late frames from a previous session after reset", () => {
    let state = createRgbdSessionState(1);
    state = applyRgbdFrameToSession(state, 1, encodeMeta(), payload2x2(), 1000);
    expect(state.cloud?.count).toBe(2);
    const previousId = state.sessionId;
    state = resetRgbdSession(state);
    expect(state.sessionId).toBe(previousId + 1);
    expect(state.cloud).toBeNull();
    state = applyRgbdFrameToSession(state, previousId, encodeMeta(), payload2x2(), 2000);
    expect(state.cloud).toBeNull();
  });

  it("reads rgb8 and bgr8", () => {
    expect(readRgb888("rgb8", new Uint8Array([255, 0, 0]), 0)).toEqual([1, 0, 0]);
    expect(readRgb888("bgr8", new Uint8Array([0, 0, 255]), 0)).toEqual([1, 0, 0]);
  });

  it("builds rotation matrices that rotate basis vectors", () => {
    // 90° about Z: (1,0,0) -> (0,1,0)
    const q = quatToMat4([0, 0, Math.SQRT1_2, Math.SQRT1_2], [0, 0, 0]);
    const p = applyPoint(q, [1, 0, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
    expect(p[2]).toBeCloseTo(0);
  });
});
