import {
  actuatedJoints,
  chainToLink,
  forwardKinematics,
  resolveTcpLink,
  solvePositionIk,
} from "./kinematicsLogic";
import type { KinematicFrame, KinematicJoint, KinematicModel, Vec3 } from "./kinematicsLogic";
import type { ControllerInfo, TrajectoryPoint } from "./types";

export type TrajectoryController = { name: string; topic: string };

/** JointTrajectoryController 的输入 Topic，与 ros2_controllers 的 `~/joint_trajectory` 约定一致。 */
export function trajectoryTopicFor(controllerName: string): string {
  const normalized = controllerName.startsWith("/") ? controllerName : `/${controllerName}`;
  return `${normalized.replace(/\/+$/, "")}/joint_trajectory`;
}

export function isTrajectoryController(controller: ControllerInfo): boolean {
  return /jointtrajectorycontroller/i.test(controller.typeName) || /traj/i.test(controller.name);
}

/** 只有 active 的轨迹控制器才能接收轨迹指令，类型匹配优先于名称匹配。 */
export function findActiveTrajectoryController(controllers: ControllerInfo[]): TrajectoryController | null {
  const active = controllers.filter((controller) => controller.state === "active");
  const match = active.find((controller) => /jointtrajectorycontroller/i.test(controller.typeName))
    ?? active.find((controller) => /traj/i.test(controller.name));
  return match ? { name: match.name, topic: trajectoryTopicFor(match.name) } : null;
}

export const TRAJECTORY_MIN_DURATION = 0.4;
export const TRAJECTORY_MAX_DURATION = 6;
export const TRAJECTORY_JOINT_SPEED = 0.6;

/** 按关节最大位移估算执行时长，量纲跟随关节本身（rad 或 m）。 */
export function trajectoryDuration(start: number[], goal: number[], jointSpeed = TRAJECTORY_JOINT_SPEED): number {
  let maxDelta = 0;
  for (let index = 0; index < start.length; index += 1) {
    const delta = Math.abs((goal[index] ?? 0) - (start[index] ?? 0));
    if (Number.isFinite(delta)) maxDelta = Math.max(maxDelta, delta);
  }
  const estimated = TRAJECTORY_MIN_DURATION + maxDelta / Math.max(jointSpeed, 1e-3);
  return Math.min(Math.max(estimated, TRAJECTORY_MIN_DURATION), TRAJECTORY_MAX_DURATION);
}

export type TrajectoryPlan = {
  /** 轨迹消息携带的全部关节，顺序与 JointState 一致。 */
  jointNames: string[];
  /** 起点关节值，取当前反馈。 */
  start: number[];
  /** 目标关节值，IK 只改写 TCP 链上的关节，其余保持当前值。 */
  goal: number[];
  /** 参与 IK 的关节名，按运动链顺序。 */
  chainJointNames: string[];
  /** 链关节在 jointNames 中的下标。 */
  chainIndices: number[];
  /** 目标关节值中链关节的部分，按运动链顺序，可直接作为下一帧 IK 种子。 */
  chainGoal: number[];
  /** TCP 目标位置（URDF 坐标系）。 */
  target: Vec3;
  /** 解算后的 TCP 位置。 */
  solved: Vec3;
  positionError: number;
  duration: number;
  points: TrajectoryPoint[];
};

export type TrajectoryPlanResult = { plan?: TrajectoryPlan; error?: string };

/**
 * 把 TCP 目标位置换算成一条可下发的 JointTrajectory。
 * 关节集合直接沿用 JointState 的 name，保证与控制器的关节列表一致。
 */
export function planTrajectory(options: {
  model: KinematicModel;
  tcpLink: string;
  jointState: { name?: string[]; position?: number[] } | null;
  target: Vec3;
  /** 上一帧 IK 解，按运动链顺序，用于拖拽热启动。 */
  seed?: number[];
}): TrajectoryPlanResult {
  const names = options.jointState?.name ?? [];
  if (names.length === 0) return { error: "JointState 尚未就绪，无法规划轨迹" };

  let chain: KinematicJoint[];
  try {
    chain = chainToLink(options.model, resolveTcpLink(options.model, options.tcpLink));
  } catch (reason) {
    return { error: reason instanceof Error ? reason.message : String(reason) };
  }
  const joints = actuatedJoints(chain);
  if (joints.length === 0) return { error: "TCP 运动链上没有可控关节" };

  const positions = names.map((_, index) => options.jointState?.position?.[index] ?? 0);
  const chainIndices = joints.map((joint) => names.indexOf(joint.name));
  const missing = joints.filter((_, index) => chainIndices[index] < 0).map((joint) => joint.name);
  if (missing.length > 0) return { error: `JointState 缺少关节：${missing.join("、")}` };

  const seed = joints.map((joint, index) => options.seed?.[index] ?? positions[chainIndices[index]]);
  const ik = solvePositionIk(chain, seed, options.target);
  const frame: KinematicFrame = forwardKinematics(chain, ik.positions);

  const start = [...positions];
  const goal = ik.positions.reduce(
    (values, value, index) => {
      values[chainIndices[index]] = value;
      return values;
    },
    [...positions],
  );

  const duration = trajectoryDuration(start, goal);
  const plan: TrajectoryPlan = {
    jointNames: [...names],
    start,
    goal,
    chainJointNames: joints.map((joint) => joint.name),
    chainIndices: [...chainIndices],
    chainGoal: [...ik.positions],
    target: options.target,
    solved: frame.position,
    positionError: ik.positionError,
    duration,
    points: [
      // 先在当前反馈位置停留一小段，避免控制器用过期状态起步造成跳变。
      { positions: [...start], time_from_start: Math.min(0.1, duration * 0.2) },
      { positions: [...goal], time_from_start: duration },
    ],
  };

  if (!ik.reached) {
    return { plan, error: `IK 未收敛：TCP 位置误差 ${(ik.positionError * 1000).toFixed(1)} mm` };
  }
  return { plan };
}

export function createTrajectoryPayload(jointNames: string[], points: TrajectoryPoint[]) {
  return {
    op: "trajectory_command",
    joint_names: jointNames,
    trajectory_points: points.map((point) => ({
      positions: point.positions,
      velocities: point.velocities ?? [],
      time_from_start: point.time_from_start,
    })),
  };
}

export type TrajectoryDispatchResult = {
  status: "sent" | "rejected";
  plan?: TrajectoryPlan;
  error?: string;
};

/**
 * 松手后的下发流程：按最新反馈重算一次轨迹，只有规划成功才调用 send。
 * 规划失败和 send 抛错都会返回 rejected，并保留已算出的 plan 供界面展示。
 */
export async function dispatchTrajectory(options: {
  model: KinematicModel;
  tcpLink: string;
  jointState: { name?: string[]; position?: number[] } | null;
  target: Vec3;
  seed?: number[];
  send(request: { jointNames: string[]; points: TrajectoryPoint[] }): Promise<void>;
}): Promise<TrajectoryDispatchResult> {
  const result = planTrajectory(options);
  if (!result.plan || result.error) {
    return { status: "rejected", plan: result.plan, error: result.error ?? "轨迹规划失败" };
  }
  try {
    await options.send({ jointNames: result.plan.jointNames, points: result.plan.points });
    return { status: "sent", plan: result.plan };
  } catch (reason) {
    return {
      status: "rejected",
      plan: result.plan,
      error: `轨迹下发失败：${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

/** 拖拽时把 IK 结果写回可视化模型；只改写链关节，其余关节保持 JointState 的值。 */
export function applyTrajectoryPlan(
  plan: TrajectoryPlan,
  setJointValue: (name: string, value: number) => void,
  values: number[] = plan.goal,
): void {
  plan.jointNames.forEach((name, index) => setJointValue(name, values[index] ?? 0));
}
