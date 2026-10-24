// URDF 运动学链解析、正运动学与位置逆运动学。
// 只依赖纯数学与 DOMParser，便于脱离 Three.js 做单元测试。

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
/** 行主序 4x4 齐次变换矩阵，长度 16。 */
export type Mat4 = number[];

export type JointType = "revolute" | "continuous" | "prismatic" | "fixed" | "floating" | "planar";

export type KinematicJoint = {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  /** 关节 <origin xyz>，单位米。 */
  origin: Vec3;
  /** 关节 <origin rpy>，固定轴 XYZ（R = Rz·Ry·Rx），单位弧度。 */
  rpy: Vec3;
  /** 关节运动轴，会归一化。 */
  axis: Vec3;
  lower: number;
  upper: number;
};

export type KinematicModel = {
  rootLink: string;
  links: string[];
  joints: KinematicJoint[];
};

export type KinematicFrame = {
  matrix: Mat4;
  position: Vec3;
  quaternion: Quat;
};

export type IkResult = {
  /** 解算得到的关节值，长度与链上可控关节数一致。 */
  positions: number[];
  /** 位置误差，单位米。 */
  positionError: number;
  iterations: number;
  reached: boolean;
};

// --- 基础线性代数 -----------------------------------------------------------

export function identity4(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mul4(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[row * 4 + k] * b[k * 4 + col];
      out[row * 4 + col] = sum;
    }
  }
  return out;
}

export function applyPoint(matrix: Mat4, point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[1] * point[1] + matrix[2] * point[2] + matrix[3],
    matrix[4] * point[0] + matrix[5] * point[1] + matrix[6] * point[2] + matrix[7],
    matrix[8] * point[0] + matrix[9] * point[1] + matrix[10] * point[2] + matrix[11],
  ];
}

export function applyVector(matrix: Mat4, vector: Vec3): Vec3 {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
    matrix[4] * vector[0] + matrix[5] * vector[1] + matrix[6] * vector[2],
    matrix[8] * vector[0] + matrix[9] * vector[1] + matrix[10] * vector[2],
  ];
}

export function translation4(offset: Vec3): Mat4 {
  const matrix = identity4();
  matrix[3] = offset[0];
  matrix[7] = offset[1];
  matrix[11] = offset[2];
  return matrix;
}

/** 固定轴 XYZ 欧拉角（URDF rpy），R = Rz(yaw)·Ry(pitch)·Rx(roll)。 */
export function rotationFromRpy(rpy: Vec3): Mat4 {
  const [roll, pitch, yaw] = rpy;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, 0,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, 0,
    -sp, cp * sr, cp * cr, 0,
    0, 0, 0, 1,
  ];
}

export function rotationFromAxisAngle(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = normalizeAxis(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

export function normalizeAxis(axis: Vec3): Vec3 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(length) || length < 1e-9) return [1, 0, 0];
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

export function matToQuat(matrix: Mat4): Quat {
  const m00 = matrix[0];
  const m11 = matrix[5];
  const m22 = matrix[10];
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (matrix[9] - matrix[6]) / s;
    y = (matrix[2] - matrix[8]) / s;
    z = (matrix[4] - matrix[1]) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (matrix[9] - matrix[6]) / s;
    x = 0.25 * s;
    y = (matrix[1] + matrix[4]) / s;
    z = (matrix[2] + matrix[8]) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (matrix[2] - matrix[8]) / s;
    x = (matrix[1] + matrix[4]) / s;
    y = 0.25 * s;
    z = (matrix[6] + matrix[9]) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (matrix[4] - matrix[1]) / s;
    x = (matrix[2] + matrix[8]) / s;
    y = (matrix[6] + matrix[9]) / s;
    z = 0.25 * s;
  }
  return [x, y, z, w];
}

/** 求解 3x3 线性方程组，奇异时返回 null。矩阵按行主序展开。 */
export function solveLinear3(matrix: number[], rhs: Vec3): Vec3 | null {
  const rows: number[][] = [
    [matrix[0], matrix[1], matrix[2], rhs[0]],
    [matrix[3], matrix[4], matrix[5], rhs[1]],
    [matrix[6], matrix[7], matrix[8], rhs[2]],
  ];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
    }
    if (Math.abs(rows[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const swap = rows[col];
      rows[col] = rows[pivot];
      rows[pivot] = swap;
    }
    const divisor = rows[col][col];
    for (let k = col; k < 4; k += 1) rows[col][k] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = rows[row][col];
      if (factor === 0) continue;
      for (let k = col; k < 4; k += 1) rows[row][k] -= factor * rows[col][k];
    }
  }
  return [rows[0][3], rows[1][3], rows[2][3]];
}

// --- 坐标系换算 -------------------------------------------------------------

// Robot View 以 rotation=[-π/2, 0, 0] 挂载 URDF，URDF 的 Z-up 被映射到 Three.js 的 Y-up。
export function urdfToScenePoint(point: Vec3): Vec3 {
  return [point[0], point[2], -point[1]];
}

export function sceneToUrdfPoint(point: Vec3): Vec3 {
  return [point[0], -point[2], point[1]];
}

export function sceneToUrdfVector(vector: Vec3): Vec3 {
  return [vector[0], -vector[2], vector[1]];
}

/** 相机正对平面时的平面法向，用于把屏幕拖拽限制在过 TCP 的正交平面上。 */
export function cameraFacingNormal(cameraPosition: Vec3, planeOrigin: Vec3): Vec3 {
  return normalizeAxis([
    cameraPosition[0] - planeOrigin[0],
    cameraPosition[1] - planeOrigin[1],
    cameraPosition[2] - planeOrigin[2],
  ]);
}

/** 射线与平面求交，平行或交点在射线后方时返回 null。 */
export function intersectRayPlane(
  origin: Vec3,
  direction: Vec3,
  planeOrigin: Vec3,
  planeNormal: Vec3,
): Vec3 | null {
  const normal = normalizeAxis(planeNormal);
  const denominator = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
  if (Math.abs(denominator) < 1e-9) return null;
  const offset = [
    planeOrigin[0] - origin[0],
    planeOrigin[1] - origin[1],
    planeOrigin[2] - origin[2],
  ];
  const distance = (offset[0] * normal[0] + offset[1] * normal[1] + offset[2] * normal[2]) / denominator;
  if (!Number.isFinite(distance) || distance < 0) return null;
  return [
    origin[0] + direction[0] * distance,
    origin[1] + direction[1] * distance,
    origin[2] + direction[2] * distance,
  ];
}

// --- URDF 解析 --------------------------------------------------------------

const JOINT_TYPES: JointType[] = ["revolute", "continuous", "prismatic", "fixed", "floating", "planar"];

function parseTuple(raw: string | null, fallback: Vec3): Vec3 {
  if (!raw) return fallback;
  const parts = raw.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return fallback;
  return [parts[0], parts[1], parts[2]];
}

function parseKinematicsXml(xml: string): Document {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) throw new Error("URDF XML 解析失败");
  return document;
}

export function parseKinematics(xml: string): KinematicModel {
  const document = parseKinematicsXml(xml);
  const links = [...document.querySelectorAll("robot > link")].map((link) => link.getAttribute("name") ?? "")
    .filter((name) => name.length > 0);
  if (links.length === 0) throw new Error("URDF 中没有可用的 link");

  const joints: KinematicJoint[] = [];
  for (const node of [...document.querySelectorAll("robot > joint")]) {
    const name = node.getAttribute("name") ?? "";
    const rawType = node.getAttribute("type") ?? "fixed";
    const type = (JOINT_TYPES.includes(rawType as JointType) ? rawType : "fixed") as JointType;
    const parent = node.querySelector("parent")?.getAttribute("link") ?? "";
    const child = node.querySelector("child")?.getAttribute("link") ?? "";
    if (!name || !parent || !child) continue;
    const origin = node.querySelector("origin");
    const axisNode = node.querySelector("axis");
    const limitNode = node.querySelector("limit");
    // URDF 规定 revolute/prismatic 必须声明 <limit>；缺失时按不限位处理，
    // 避免凭空捏造限位把真实可达的目标挡在外面。
    const hasLimit = type === "revolute" || type === "prismatic";
    const rawLower = limitNode?.getAttribute("lower") ?? "";
    const rawUpper = limitNode?.getAttribute("upper") ?? "";
    const lower = hasLimit && rawLower.trim() !== "" ? Number(rawLower) : Number.NaN;
    const upper = hasLimit && rawUpper.trim() !== "" ? Number(rawUpper) : Number.NaN;
    joints.push({
      name,
      type,
      parent,
      child,
      origin: parseTuple(origin?.getAttribute("xyz") ?? null, [0, 0, 0]),
      rpy: parseTuple(origin?.getAttribute("rpy") ?? null, [0, 0, 0]),
      axis: parseTuple(axisNode?.getAttribute("xyz") ?? null, [1, 0, 0]),
      lower: Number.isFinite(lower) ? lower : Number.NEGATIVE_INFINITY,
      upper: Number.isFinite(upper) ? upper : Number.POSITIVE_INFINITY,
    });
  }

  const childLinks = new Set(joints.map((joint) => joint.child));
  const roots = links.filter((link) => !childLinks.has(link));
  return { rootLink: roots[0] ?? links[0], links, joints };
}

/** 从根 link 到目标 link 的关节链，顺序为从基座到末端。 */
export function chainToLink(model: KinematicModel, linkName: string): KinematicJoint[] {
  if (!model.links.includes(linkName)) {
    throw new Error(`URDF 中不存在 link：${linkName}`);
  }
  const byChild = new Map(model.joints.map((joint) => [joint.child, joint]));
  const chain: KinematicJoint[] = [];
  let cursor = linkName;
  const seen = new Set<string>();
  while (cursor !== model.rootLink) {
    if (seen.has(cursor)) throw new Error("URDF 关节树存在环");
    seen.add(cursor);
    const joint = byChild.get(cursor);
    if (!joint) {
      if (chain.length === 0) throw new Error(`link ${linkName} 不在根 link ${model.rootLink} 的运动链上`);
      break;
    }
    chain.push(joint);
    cursor = joint.parent;
  }
  return chain.reverse();
}

const TCP_NAME_PATTERN = /tool0|tcp|ee_link|end[_.-]?effector|gripper|flange|suction|hand|tool/i;
const FINGER_NAME_PATTERN = /finger|jaw/i;

export function linkDepth(model: KinematicModel, linkName: string): number {
  return chainToLink(model, linkName).length;
}

/**
 * 显式配置优先；自动选择稳定的工具坐标系（可以有手指子 link），
 * 避免把夹爪开合自由度当作机械臂的 TCP 位置自由度。
 */
export function resolveTcpLink(model: KinematicModel, configured?: string): string {
  const wanted = (configured ?? "").trim();
  if (wanted) {
    if (!model.links.includes(wanted)) throw new Error(`配置的 TCP link 不存在：${wanted}`);
    return wanted;
  }
  const parentLinks = new Set(model.joints.map((joint) => joint.parent));
  const leaves = model.links.filter((link) => !parentLinks.has(link));
  if (leaves.length === 0) throw new Error("URDF 中没有末端 link");
  const tools = model.links.filter((link) => TCP_NAME_PATTERN.test(link) && !FINGER_NAME_PATTERN.test(link));
  const candidates = tools.length ? tools : leaves;
  let best = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const link of candidates) {
    const explicitTool = /(^|[_/.-])(tcp|tool0|ee_link)([_/.-]|$)/i.test(link);
    const score = (explicitTool ? 2000 : TCP_NAME_PATTERN.test(link) ? 1000 : 0) + linkDepth(model, link);
    if (score > bestScore || (score === bestScore && link < best)) {
      best = link;
      bestScore = score;
    }
  }
  return best;
}

// --- 正运动学 ----------------------------------------------------------------

export function jointOriginMatrix(joint: KinematicJoint): Mat4 {
  return mul4(translation4(joint.origin), rotationFromRpy(joint.rpy));
}

export function jointMotionMatrix(joint: KinematicJoint, value: number): Mat4 {
  if (joint.type === "revolute" || joint.type === "continuous") {
    return rotationFromAxisAngle(joint.axis, value);
  }
  if (joint.type === "prismatic") {
    const axis = normalizeAxis(joint.axis);
    return translation4([axis[0] * value, axis[1] * value, axis[2] * value]);
  }
  return identity4();
}

/** values 只覆盖链上的可控关节（revolute/continuous/prismatic），顺序与 chain 中出现顺序一致。 */
export function forwardKinematics(chain: KinematicJoint[], values: number[]): KinematicFrame {
  let matrix = identity4();
  let cursor = 0;
  for (const joint of chain) {
    matrix = mul4(matrix, jointOriginMatrix(joint));
    if (joint.type === "fixed") continue;
    matrix = mul4(matrix, jointMotionMatrix(joint, values[cursor] ?? 0));
    cursor += 1;
  }
  return { matrix, position: applyPoint(matrix, [0, 0, 0]), quaternion: matToQuat(matrix) };
}

export function actuatedJoints(chain: KinematicJoint[]): KinematicJoint[] {
  return chain.filter((joint) => joint.type !== "fixed" && joint.type !== "floating" && joint.type !== "planar");
}

export function clampToLimits(joint: KinematicJoint, value: number): number {
  if (!Number.isFinite(value)) return 0;
  const lower = Number.isFinite(joint.lower) ? joint.lower : value;
  const upper = Number.isFinite(joint.upper) ? joint.upper : value;
  return Math.min(Math.max(value, lower), upper);
}

// --- 位置逆运动学 -------------------------------------------------------------

export type IkOptions = {
  /** 每次下降的迭代上限。 */
  maxIterations?: number;
  /** 位置收敛阈值，单位米。 */
  tolerance?: number;
  /** 初始阻尼比，按 JJᵀ 的量级自适应缩放。 */
  damping?: number;
  /** 单步关节增量上限。 */
  stepLimit?: number;
  /** 有限差分步长。 */
  jacobianStep?: number;
  /** 卡住后随机重启的次数。 */
  maxRestarts?: number;
  /** 随机重启的种子，保证测试可复现。 */
  seed?: number;
};

type IkAttempt = { positions: number[]; error: number; iterations: number };

/**
 * 默认位置收敛阈值。拖拽是手势式定位，把夹爪放到离目标几毫米内就是用户意图；
 * 真正不可达的目标残差通常是厘米级，5 mm 能把两者干净分开。
 */
export const IK_POSITION_TOLERANCE = 0.005;

/** 确定性伪随机数，保证随机重启可复现。 */
function makeRandom(seed: number): () => number {
  let state = (Math.floor(seed) || 1) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomStart(joints: KinematicJoint[], seed: number[], random: () => number): number[] {
  return joints.map((joint, index) => {
    const lower = Number.isFinite(joint.lower) ? joint.lower : (seed[index] ?? 0) - Math.PI;
    const upper = Number.isFinite(joint.upper) ? joint.upper : (seed[index] ?? 0) + Math.PI;
    return lower + (upper - lower) * random();
  });
}

function chainError(chain: KinematicJoint[], values: number[], target: Vec3): number {
  return distance3(forwardKinematics(chain, values).position, target);
}

function descend(
  chain: KinematicJoint[],
  joints: KinematicJoint[],
  start: number[],
  target: Vec3,
  options: Required<Pick<IkOptions, "maxIterations" | "tolerance" | "damping" | "stepLimit" | "jacobianStep">>,
): IkAttempt {
  const values = [...start];
  let lambda = options.damping;
  let iterations = 0;
  let error = chainError(chain, values, target);
  while (iterations < options.maxIterations && error > options.tolerance) {
    iterations += 1;
    const jacobian = positionJacobian(chain, values, options.jacobianStep);
    const current = forwardKinematics(chain, values).position;
    const residual: Vec3 = [target[0] - current[0], target[1] - current[1], target[2] - current[2]];

    // JJᵀ 的对角均值用于把阻尼缩放到与雅可比同量级（Levenberg-Marquardt 缩放）。
    const gram = new Array<number>(9).fill(0);
    let trace = 0;
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        let sum = 0;
        for (let k = 0; k < joints.length; k += 1) sum += jacobian[row][k] * jacobian[col][k];
        gram[row * 3 + col] = sum;
        if (row === col) trace += sum;
      }
    }
    const scale = Math.max(trace / 3, 1e-9);

    let accepted = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const normal = [...gram];
      for (let row = 0; row < 3; row += 1) normal[row * 3 + row] += lambda * scale;
      const weights = solveLinear3(normal, residual);
      if (!weights) {
        lambda = Math.min(lambda * 4, 1e6);
        continue;
      }
      const trial = [...values];
      for (let k = 0; k < joints.length; k += 1) {
        let delta = 0;
        for (let row = 0; row < 3; row += 1) delta += jacobian[row][k] * weights[row];
        const limited = Math.min(Math.max(delta, -options.stepLimit), options.stepLimit);
        trial[k] = clampToLimits(joints[k], values[k] + limited);
      }
      const trialError = chainError(chain, trial, target);
      if (trialError < error) {
        values.splice(0, values.length, ...trial);
        error = trialError;
        lambda = Math.max(lambda / 3, 1e-6);
        accepted = true;
        break;
      }
      lambda = Math.min(lambda * 4, 1e6);
    }
    if (!accepted) break;
  }
  return { positions: values, error, iterations };
}

/**
 * 位置逆解：保持当前姿态不变，只把 TCP 位置拉向 target。
 * 有限差分雅可比 + 自适应阻尼最小二乘，带关节限位钳制；单次下降卡住时做确定性随机重启。
 */
export function solvePositionIk(
  chain: KinematicJoint[],
  seed: number[],
  target: Vec3,
  options: IkOptions = {},
): IkResult {
  const joints = actuatedJoints(chain);
  const tolerance = options.tolerance ?? IK_POSITION_TOLERANCE;
  const settings = {
    maxIterations: options.maxIterations ?? 60,
    tolerance,
    damping: options.damping ?? 1e-3,
    stepLimit: options.stepLimit ?? 0.35,
    jacobianStep: options.jacobianStep ?? 1e-4,
  };

  const clampedSeed = joints.map((joint, index) => clampToLimits(joint, seed[index] ?? 0));
  if (joints.length === 0) {
    const error = chainError(chain, clampedSeed, target);
    return { positions: clampedSeed, positionError: error, iterations: 0, reached: error <= tolerance };
  }

  const random = makeRandom(options.seed ?? 7);
  const maxRestarts = options.maxRestarts ?? 8;
  // 求解阶段始终往 1 mm 以内压，避免放宽 tolerance 顺带降低解的质量；
  // tolerance 只决定结果是否算作收敛。
  const solveTolerance = Math.min(tolerance, 1e-3);
  let best = descend(chain, joints, clampedSeed, target, { ...settings, tolerance: solveTolerance });
  let iterations = best.iterations;
  // 只有结果会被判为未收敛时才做随机重启，避免拖拽每帧都白跑多次下降。
  for (let restart = 0; restart < maxRestarts && best.error > tolerance; restart += 1) {
    const attempt = descend(chain, joints, randomStart(joints, clampedSeed, random), target, { ...settings, tolerance: solveTolerance });
    iterations += attempt.iterations;
    if (attempt.error < best.error) best = attempt;
  }

  return {
    positions: best.positions,
    positionError: best.error,
    iterations,
    reached: best.error <= tolerance,
  };
}

function positionJacobian(chain: KinematicJoint[], values: number[], step: number): number[][] {
  const joints = actuatedJoints(chain);
  const base = forwardKinematics(chain, values).position;
  const jacobian = [new Array<number>(joints.length).fill(0), new Array<number>(joints.length).fill(0), new Array<number>(joints.length).fill(0)];
  for (let k = 0; k < joints.length; k += 1) {
    const perturbed = [...values];
    perturbed[k] += step;
    const moved = forwardKinematics(chain, perturbed).position;
    for (let row = 0; row < 3; row += 1) jacobian[row][k] = (moved[row] - base[row]) / step;
  }
  return jacobian;
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
