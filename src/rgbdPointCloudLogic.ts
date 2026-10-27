import { applyPoint, type Mat4, type Quat, type Vec3, urdfToScenePoint } from "./kinematicsLogic";

/** RGBD binary frame magic: RCD1 */
export const RGBD_MAGIC = [0x52, 0x43, 0x44, 0x31] as const;

export type RosHeader = {
  stamp?: { sec?: number; nanosec?: number };
  frame_id?: string;
};

export type RgbdImageMeta = {
  header?: RosHeader;
  height: number;
  width: number;
  encoding: string;
  is_bigendian?: number | boolean;
  step: number;
  data_length: number;
  data_offset: number;
};

export type RgbdCameraInfo = {
  header?: RosHeader;
  width: number;
  height: number;
  distortion_model?: string;
  d?: number[];
  /** Row-major 3x3 camera matrix K = [fx 0 cx; 0 fy cy; 0 0 1]. */
  k: number[];
};

export type RgbdPose = {
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};

export type RgbdFrameMeta = {
  op: "rgbd_frame";
  rgb_topic?: string;
  depth_topic?: string;
  camera_info_topic?: string;
  target_frame?: string;
  source_frame?: string;
  stamp_diff_ns?: number;
  tf_ok: boolean;
  tf_error?: string;
  /** Non-TF failure (resolution/encoding). */
  error?: string;
  rgb: RgbdImageMeta;
  depth: RgbdImageMeta;
  camera_info: RgbdCameraInfo;
  pose?: RgbdPose;
};

export type ColoredPointCloud = {
  /** Positions in URDF / base_link meters (Z-up). */
  positions: Float32Array;
  /** RGB in 0–1. */
  colors: Float32Array;
  /** Optical-frame depth meters per point (for depth coloring). */
  depths: Float32Array;
  count: number;
  sourceFrame: string;
  targetFrame: string;
  stampDiffNs: number;
};

export type RgbdSessionState = {
  sessionId: number;
  cloud: ColoredPointCloud | null;
  stale: boolean;
  tfOk: boolean;
  tfError: string;
  visible: boolean;
  fps: number;
  lastFrameAt: number;
  pointSize: number;
  nearM: number;
  farM: number;
  enabled: boolean;
};

export const DEFAULT_RGBD_TOPICS = {
  rgbTopic: "/camera/color/image_raw",
  depthTopic: "/camera/aligned_depth_to_color/image_raw",
  cameraInfoTopic: "/camera/color/camera_info",
  targetFrame: "base_link",
  maxWidth: 320,
  maxHeight: 240,
  maxFps: 12,
} as const;

const DEPTH_MM_SCALE = 0.001;

export function isBigEndian(flag: number | boolean | undefined): boolean {
  return flag === true || Number(flag) === 1;
}

export function stampToNs(stamp?: { sec?: number; nanosec?: number }): number | null {
  if (!stamp || !Number.isFinite(Number(stamp.sec)) || !Number.isFinite(Number(stamp.nanosec))) return null;
  return Number(stamp.sec) * 1_000_000_000 + Number(stamp.nanosec);
}

export function stampsWithinTolerance(
  a?: { sec?: number; nanosec?: number },
  b?: { sec?: number; nanosec?: number },
  toleranceNs = 50_000_000,
): { ok: boolean; diffNs: number } {
  const left = stampToNs(a);
  const right = stampToNs(b);
  if (left === null || right === null) return { ok: false, diffNs: Number.POSITIVE_INFINITY };
  const diffNs = Math.abs(left - right);
  return { ok: diffNs <= toleranceNs, diffNs };
}

/** Scale CameraInfo K for a resized preview (nearest-neighbor downsample). */
export function scaleIntrinsics(
  k: number[],
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): number[] {
  if (k.length < 9) throw new Error("CameraInfo.K 长度不足 9");
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    throw new Error("降采样宽高无效");
  }
  const sx = dstWidth / srcWidth;
  const sy = dstHeight / srcHeight;
  return [
    k[0] * sx, k[1] * sx, k[2] * sx,
    k[3] * sy, k[4] * sy, k[5] * sy,
    k[6], k[7], k[8],
  ];
}

export function choosePreviewSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error("图像宽高无效");
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function depthMetersFromBytes(
  encoding: string,
  bytes: Uint8Array,
  offset: number,
  bigEndian: boolean,
): number | null {
  const kind = encoding.toLowerCase();
  if (kind === "16uc1" || kind === "mono16") {
    if (offset + 1 >= bytes.length) return null;
    const raw = bigEndian
      ? (bytes[offset] << 8) | bytes[offset + 1]
      : bytes[offset] | (bytes[offset + 1] << 8);
    if (raw === 0) return null;
    return raw * DEPTH_MM_SCALE;
  }
  if (kind === "32fc1") {
    if (offset + 3 >= bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    const meters = view.getFloat32(0, !bigEndian);
    if (!Number.isFinite(meters) || meters <= 0) return null;
    return meters;
  }
  throw new Error(`不支持的深度编码：${encoding || "未知"}`);
}

export function readRgb888(
  encoding: string,
  bytes: Uint8Array,
  offset: number,
): [number, number, number] | null {
  const kind = encoding.toLowerCase();
  if (kind === "rgb8" || kind === "8uc3") {
    if (offset + 2 >= bytes.length) return null;
    return [bytes[offset] / 255, bytes[offset + 1] / 255, bytes[offset + 2] / 255];
  }
  if (kind === "bgr8") {
    if (offset + 2 >= bytes.length) return null;
    return [bytes[offset + 2] / 255, bytes[offset + 1] / 255, bytes[offset] / 255];
  }
  if (kind === "rgba8" || kind === "8uc4") {
    if (offset + 2 >= bytes.length) return null;
    return [bytes[offset] / 255, bytes[offset + 1] / 255, bytes[offset + 2] / 255];
  }
  if (kind === "bgra8") {
    if (offset + 2 >= bytes.length) return null;
    return [bytes[offset + 2] / 255, bytes[offset + 1] / 255, bytes[offset] / 255];
  }
  if (kind === "mono8" || kind === "8uc1") {
    if (offset >= bytes.length) return null;
    const g = bytes[offset] / 255;
    return [g, g, g];
  }
  throw new Error(`不支持的 RGB 编码：${encoding || "未知"}`);
}

export function quatToMat4(rotation: Quat, translation: Vec3): Mat4 {
  const [x, y, z, w] = rotation;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), translation[0],
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), translation[1],
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), translation[2],
    0, 0, 0, 1,
  ];
}

export function poseToMat4(pose: RgbdPose): Mat4 {
  return quatToMat4(
    [pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w],
    [pose.translation.x, pose.translation.y, pose.translation.z],
  );
}

export function backProjectPixel(
  u: number,
  v: number,
  depthM: number,
  fx: number,
  fy: number,
  cx: number,
  cy: number,
): Vec3 {
  return [(u - cx) * depthM / fx, (v - cy) * depthM / fy, depthM];
}

export type BuildCloudOptions = {
  nearM?: number;
  farM?: number;
};

/**
 * Build a colored point cloud in target_frame (usually base_link) from a decoded RGBD frame.
 * Does not reuse grayscale depth preview pixels — reads raw depth encodings only.
 */
export function buildColoredPointCloud(
  meta: RgbdFrameMeta,
  payload: Uint8Array,
  options: BuildCloudOptions = {},
): ColoredPointCloud {
  if (!meta.tf_ok || !meta.pose) {
    throw new Error(meta.tf_error || "TF 不可用，跳过点云更新");
  }
  const nearM = options.nearM ?? 0.05;
  const farM = options.farM ?? 3.0;
  const rgb = meta.rgb;
  const depth = meta.depth;
  const info = meta.camera_info;
  if (rgb.width !== depth.width || rgb.height !== depth.height) {
    throw new Error("RGB 与 Depth 分辨率不一致");
  }
  if (info.k.length < 9) throw new Error("CameraInfo.K 无效");
  if (rgb.data_offset + rgb.data_length > payload.length) throw new Error("RGB 负载越界");
  if (depth.data_offset + depth.data_length > payload.length) throw new Error("Depth 负载越界");

  const fx = info.k[0];
  const fy = info.k[4];
  const cx = info.k[2];
  const cy = info.k[5];
  if (!(fx > 0) || !(fy > 0)) throw new Error("焦距无效");

  const rgbBytes = payload.subarray(rgb.data_offset, rgb.data_offset + rgb.data_length);
  const depthBytes = payload.subarray(depth.data_offset, depth.data_offset + depth.data_length);
  const depthEndian = isBigEndian(depth.is_bigendian);
  const transform = poseToMat4(meta.pose);

  const maxPoints = rgb.width * rgb.height;
  const positions = new Float32Array(maxPoints * 3);
  const colors = new Float32Array(maxPoints * 3);
  const depths = new Float32Array(maxPoints);
  let count = 0;

  const rgbBpp = rgb.encoding.toLowerCase().includes("4") ? 4 : rgb.encoding.toLowerCase().includes("mono8") || rgb.encoding.toLowerCase() === "8uc1" ? 1 : 3;
  const depthBpp = depth.encoding.toLowerCase() === "32fc1" ? 4 : 2;

  for (let v = 0; v < rgb.height; v += 1) {
    for (let u = 0; u < rgb.width; u += 1) {
      const depthOffset = v * depth.step + u * depthBpp;
      const depthM = depthMetersFromBytes(depth.encoding, depthBytes, depthOffset, depthEndian);
      if (depthM === null || depthM < nearM || depthM > farM) continue;
      const rgbOffset = v * rgb.step + u * rgbBpp;
      const color = readRgb888(rgb.encoding, rgbBytes, rgbOffset);
      if (!color) continue;
      const optical = backProjectPixel(u + 0.5, v + 0.5, depthM, fx, fy, cx, cy);
      const base = applyPoint(transform, optical);
      const i = count * 3;
      positions[i] = base[0];
      positions[i + 1] = base[1];
      positions[i + 2] = base[2];
      colors[i] = color[0];
      colors[i + 1] = color[1];
      colors[i + 2] = color[2];
      depths[count] = depthM;
      count += 1;
    }
  }

  return {
    positions: positions.subarray(0, count * 3),
    colors: colors.subarray(0, count * 3),
    depths: depths.subarray(0, count),
    count,
    sourceFrame: meta.source_frame || meta.rgb.header?.frame_id || "",
    targetFrame: meta.target_frame || "base_link",
    stampDiffNs: meta.stamp_diff_ns ?? 0,
  };
}

/** Convert URDF/base_link cloud positions into Three.js scene coordinates. */
export function cloudPositionsToScene(positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const scene = urdfToScenePoint([positions[i], positions[i + 1], positions[i + 2]]);
    out[i] = scene[0];
    out[i + 1] = scene[1];
    out[i + 2] = scene[2];
  }
  return out;
}

/**
 * Latest-only frame group queue: pushing a new complete group drops the previous
 * unfinished/complete group as a whole (no RGB/Depth/pose mixing across groups).
 */
export class LatestFrameGroupQueue<T> {
  private current: T | null = null;
  private dropped = 0;

  push(group: T): void {
    if (this.current !== null) this.dropped += 1;
    this.current = group;
  }

  take(): T | null {
    const value = this.current;
    this.current = null;
    return value;
  }

  peek(): T | null {
    return this.current;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.current = null;
  }
}

export function createRgbdSessionState(sessionId = 1): RgbdSessionState {
  return {
    sessionId,
    cloud: null,
    stale: false,
    tfOk: true,
    tfError: "",
    visible: true,
    fps: 0,
    lastFrameAt: 0,
    pointSize: 0.008,
    nearM: 0.05,
    farM: 3.0,
    enabled: true,
  };
}

/**
 * Apply an incoming RGBD frame to session state. TF failure marks stale and keeps
 * the last cloud. Session id mismatch (reconnect) rejects late frames.
 */
export function applyRgbdFrameToSession(
  state: RgbdSessionState,
  sessionId: number,
  meta: RgbdFrameMeta,
  payload: Uint8Array,
  nowMs = Date.now(),
): RgbdSessionState {
  if (sessionId !== state.sessionId) {
    return state;
  }
  if (!meta.tf_ok) {
    return {
      ...state,
      stale: true,
      tfOk: false,
      tfError: meta.error || meta.tf_error || "TF 查询失败",
    };
  }
  try {
    const cloud = buildColoredPointCloud(meta, payload, { nearM: state.nearM, farM: state.farM });
    const dt = state.lastFrameAt > 0 ? (nowMs - state.lastFrameAt) / 1000 : 0;
    const fps = dt > 0 ? Math.min(60, 1 / dt) : state.fps;
    return {
      ...state,
      cloud,
      stale: false,
      tfOk: true,
      tfError: "",
      fps,
      lastFrameAt: nowMs,
    };
  } catch (reason) {
    return {
      ...state,
      stale: true,
      tfOk: false,
      tfError: reason instanceof Error ? reason.message : String(reason),
    };
  }
}

/** Clear GPU/session state on disconnect or reconnect. */
export function resetRgbdSession(previous: RgbdSessionState): RgbdSessionState {
  return {
    ...createRgbdSessionState(previous.sessionId + 1),
    pointSize: previous.pointSize,
    nearM: previous.nearM,
    farM: previous.farM,
    enabled: previous.enabled,
  };
}

export function parseRgbdFrameMeta(value: unknown): RgbdFrameMeta {
  if (!value || typeof value !== "object") throw new Error("RGBD 元数据无效");
  const meta = value as RgbdFrameMeta;
  if (meta.op !== "rgbd_frame") throw new Error("非 RGBD 帧");
  if (meta.tf_ok === false) return meta;
  if (!meta.rgb || !meta.depth || !meta.camera_info) throw new Error("RGBD 帧缺少图像或内参");
  return meta;
}
