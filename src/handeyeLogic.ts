import type { ConnectionProfile } from "./types";
export type HandeyeBoard = {
  kind: "charuco" | "aruco";
  dictionary: string;
  squares_x: number;
  squares_y: number;
  square_m: number;
  marker_m: number;
  legacy_pattern: boolean;
};
export type HandeyeContext = {
  mode: "eye_in_hand" | "eye_to_hand";
  image_topic: string;
  camera_info_topic: string;
  joint_topic: string;
  base_frame: string;
  eef_frame: string;
  sensor_frame: string;
  camera_body_frame: string;
};
export type HandeyeCapture = {
  image_png: string;
  stamp_ns: string;
  width: number;
  height: number;
  k: number[];
  d: number[];
  distortion_model: string;
  sensor_frame: string;
  robot: number[];
  body_to_sensor: number[];
  frame_age_ms: number;
  joints: {
    stamp_ns: number;
    names: string[];
    positions: number[];
    velocities: number[];
  };
};
export type HandeyeDetection = {
  target: number[];
  corners: number;
  corner_ids: number[];
  rms_px: number;
  max_px: number;
  coverage: number;
  annotated_png: string;
};
export type HandeyeSample = {
  id: string;
  role: "training" | "validation" | "excluded";
  capture: HandeyeCapture;
  detection: HandeyeDetection;
};
export type HandeyeResiduals = {
  samples: Array<{ translation_m: number; rotation_deg: number }>;
  translation_rms_m: number;
  rotation_rms_deg: number;
  translation_max_m: number;
  rotation_max_deg: number;
};
export type HandeyeResult = {
  transform: number[];
  reference_target: number[];
  training: HandeyeResiduals;
  validation: HandeyeResiduals;
  validated: boolean;
  method: string;
  mode: string;
  opencv_version: string;
};
export type HandeyeDataset = {
  version: 1;
  board: HandeyeBoard;
  context: HandeyeContext;
  source_key: string;
  samples: HandeyeSample[];
};
export const DEFAULT_BOARD: HandeyeBoard = {
  kind: "charuco",
  dictionary: "DICT_5X5_250",
  squares_x: 12,
  squares_y: 9,
  square_m: 0.015,
  marker_m: 0.01125,
  legacy_pattern: true,
};
export function defaultHandeyeContext(
  profile: ConnectionProfile,
): HandeyeContext {
  return {
    mode: "eye_in_hand",
    image_topic:
      profile.rgbdRgbTopic || "/cameras/left_arm/wrist/color/image_raw",
    camera_info_topic:
      profile.rgbdCameraInfoTopic ||
      "/cameras/left_arm/wrist/color/camera_info",
    joint_topic: "/robot_feedback/joint_states",
    base_frame: "base_link",
    eef_frame: "link6",
    sensor_frame: "left_arm/wrist_color_optical_frame",
    camera_body_frame: "camera_link",
  };
}
export function handeyeSource(profile: ConnectionProfile) {
  return JSON.stringify([
    profile.host,
    profile.sshPort,
    profile.username,
    profile.rosDomainId,
    profile.rosSetupScript,
  ]);
}
export function handeyeConfigError(
  board: HandeyeBoard,
  context: HandeyeContext,
): string {
  if (
    !["charuco", "aruco"].includes(board.kind) ||
    !["DICT_4X4_50", "DICT_5X5_250", "DICT_6X6_250"].includes(board.dictionary)
  )
    return "不支持的标定板类型/字典";
  if (
    ![board.squares_x, board.squares_y].every(
      (n) => Number.isInteger(n) && n >= 3 && n <= 30,
    )
  )
    return "标定板行列数须为 3–30";
  if (
    !Number.isFinite(board.square_m) ||
    !Number.isFinite(board.marker_m) ||
    board.square_m < 0.002 ||
    board.square_m > 0.2 ||
    board.marker_m < 0.001 ||
    board.marker_m >= board.square_m
  )
    return "请填写有效实测尺寸：格子边长大于标记边长（单位 mm）";
  if (typeof board.legacy_pattern !== "boolean") return "缺少标定板版本";
  if (!["eye_in_hand", "eye_to_hand"].includes(context.mode))
    return "未知的相机安装方式";
  for (const [key, value] of Object.entries(context))
    if (
      key !== "mode" &&
      (typeof value !== "string" ||
        !/^\/?[A-Za-z0-9_][A-Za-z0-9_/]{0,198}$/.test(value))
    )
      return `无效 Topic / Frame：${key}`;
  if (context.base_frame === context.eef_frame)
    return "Base 与 End-effector 不能相同";
  return "";
}
export function validTransform(a: unknown): a is number[] {
  if (!Array.isArray(a) || a.length !== 16 || !a.every(Number.isFinite))
    return false;
  if (
    Math.abs(a[12]) + Math.abs(a[13]) + Math.abs(a[14]) + Math.abs(a[15] - 1) >
    1e-6
  )
    return false;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let dot = 0;
      for (let k = 0; k < 3; k++) dot += a[i * 4 + k] * a[j * 4 + k];
      if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-5) return false;
    }
  const det =
    a[0] * (a[5] * a[10] - a[6] * a[9]) -
    a[1] * (a[4] * a[10] - a[6] * a[8]) +
    a[2] * (a[4] * a[9] - a[5] * a[8]);
  return Math.abs(det - 1) < 1e-5;
}
export function multiplyTransform(a: number[], b: number[]) {
  return Array.from({ length: 16 }, (_, i) => {
    let n = 0;
    for (let k = 0; k < 4; k++)
      n += a[Math.floor(i / 4) * 4 + k] * b[k * 4 + (i % 4)];
    return n;
  });
}
export function inverseTransform(a: number[]) {
  return [
    a[0],
    a[4],
    a[8],
    -(a[0] * a[3] + a[4] * a[7] + a[8] * a[11]),
    a[1],
    a[5],
    a[9],
    -(a[1] * a[3] + a[5] * a[7] + a[9] * a[11]),
    a[2],
    a[6],
    a[10],
    -(a[2] * a[3] + a[6] * a[7] + a[10] * a[11]),
    0,
    0,
    0,
    1,
  ];
}
export function poseAngle(a: number[], b: number[]) {
  let trace = 0;
  for (let i = 0; i < 3; i++)
    for (let k = 0; k < 3; k++) trace += a[k * 4 + i] * b[k * 4 + i];
  return (
    (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI
  );
}
export function sampleConflict(
  samples: HandeyeSample[],
  capture: HandeyeCapture,
): string {
  if (!validTransform(capture.robot) || !validTransform(capture.body_to_sensor))
    return "采样 TF 无效";
  if (samples.some((s) => s.capture.stamp_ns === capture.stamp_ns))
    return "重复的图像帧，未记录";
  const first = samples[0]?.capture;
  if (
    first &&
    JSON.stringify([
      first.k,
      first.d,
      first.width,
      first.height,
      first.sensor_frame,
      first.distortion_model,
    ]) !==
      JSON.stringify([
        capture.k,
        capture.d,
        capture.width,
        capture.height,
        capture.sensor_frame,
        capture.distortion_model,
      ])
  )
    return "相机内参、分辨率或坐标系已改变，请新建数据集";
  if (
    first &&
    capture.body_to_sensor.some(
      (x, i) => Math.abs(x - first.body_to_sensor[i]) > 1e-5,
    )
  )
    return "相机机身到光学帧的固定变换已改变，请新建数据集";
  if (
    samples.some(
      (s) =>
        s.role !== "excluded" && poseAngle(s.capture.robot, capture.robot) < 5,
    )
  )
    return "末端旋转与已有样本不足 5°，请换一个姿态";
  return "";
}
export function solverRequest(dataset: HandeyeDataset, method: string) {
  const group = (role: HandeyeSample["role"]) =>
    dataset.samples
      .filter((s) => s.role === role)
      .map((s) => ({ robot: s.capture.robot, target: s.detection.target }));
  return {
    op: "solve",
    method,
    mode: dataset.context.mode,
    samples: group("training"),
    validation: group("validation"),
  };
}
export function parseHandeyeDataset(text: string): HandeyeDataset {
  if (text.length > 128 * 1024 * 1024) throw new Error("数据集超过 128 MiB");
  const d = JSON.parse(text) as HandeyeDataset;
  if (
    d?.version !== 1 ||
    !d.board ||
    !d.context ||
    typeof d.source_key !== "string" ||
    !Array.isArray(d.samples) ||
    d.samples.length > 200
  )
    throw new Error("不是受支持的手眼数据集");
  const error = handeyeConfigError(d.board, d.context);
  if (error) throw new Error(error);
  const ids = new Set<string>();
  const stamps = new Set<string>();
  for (const s of d.samples) {
    const c = s.capture,
      det = s.detection;
    if (
      !s.id ||
      ids.has(s.id) ||
      !["training", "validation", "excluded"].includes(s.role) ||
      !c ||
      !det
    )
      throw new Error("样本编号或角色无效");
    ids.add(s.id);
    if (
      typeof c.stamp_ns !== "string" ||
      !/^\d+$/.test(c.stamp_ns) ||
      stamps.has(c.stamp_ns)
    )
      throw new Error("重复或无效的图像时间戳");
    stamps.add(c.stamp_ns);
    if (
      !validTransform(c.robot) ||
      !validTransform(c.body_to_sensor) ||
      !validTransform(det.target)
    )
      throw new Error("样本变换无效");
    if (
      !Array.isArray(c.k) ||
      c.k.length !== 9 ||
      !c.k.every(Number.isFinite) ||
      c.k[0] <= 0 ||
      c.k[4] <= 0 ||
      !Array.isArray(c.d) ||
      !c.d.every(Number.isFinite)
    )
      throw new Error("相机内参无效");
    if (
      ![c.width, c.height].every(
        (n) => Number.isInteger(n) && n > 0 && n <= 4096,
      ) ||
      c.sensor_frame !== d.context.sensor_frame
    )
      throw new Error("样本图像尺寸或坐标系无效");
    if (
      typeof c.image_png !== "string" ||
      !c.image_png.startsWith("iVBORw0KGgo") ||
      c.image_png.length > 24 * 1024 * 1024
    )
      throw new Error("样本 PNG 无效");
    if (
      !Number.isFinite(det.rms_px) ||
      det.rms_px < 0 ||
      det.rms_px > 1.5 ||
      !Number.isFinite(det.max_px) ||
      det.max_px > 4 ||
      !Number.isFinite(det.coverage) ||
      det.coverage < 0.01 ||
      !Number.isInteger(det.corners) ||
      det.corners < 8
    )
      throw new Error("样本检测质量无效");
  }
  const first = d.samples[0]?.capture;
  if (first)
    for (const s of d.samples.slice(1)) {
      const err = sampleConflict([{ ...d.samples[0], role: "excluded" }], {
        ...s.capture,
        stamp_ns: s.capture.stamp_ns,
      });
      if (err) throw new Error(err);
    }
  return d;
}
export function handeyeExport(dataset: HandeyeDataset, result: HandeyeResult) {
  if (!validTransform(result.transform) || !dataset.samples.length)
    throw new Error("没有可导出的求解结果");
  const parent =
    dataset.context.mode === "eye_in_hand"
      ? dataset.context.eef_frame
      : dataset.context.base_frame;
  const body = multiplyTransform(
    result.transform,
    inverseTransform(dataset.samples[0].capture.body_to_sensor),
  );
  const sy = Math.hypot(body[0], body[4]);
  const rpy =
    sy > 1e-6
      ? [
          Math.atan2(body[9], body[10]),
          Math.atan2(-body[8], sy),
          Math.atan2(body[4], body[0]),
        ]
      : [Math.atan2(-body[6], body[5]), Math.atan2(-body[8], sy), 0];
  return {
    version: 1,
    created_at: new Date().toISOString(),
    parent_frame: parent,
    sensor_frame: dataset.context.sensor_frame,
    camera_body_frame: dataset.context.camera_body_frame,
    convention:
      "row-major T_parent_child maps child coordinates into parent; translation in metres",
    parent_from_sensor: result.transform,
    parent_from_camera_body: body,
    xyz_m: [body[3], body[7], body[11]],
    rpy_rad: rpy,
    result,
    plane_verified: false,
    applied: false,
    board: dataset.board,
    context: dataset.context,
    source_key: dataset.source_key,
  };
}
