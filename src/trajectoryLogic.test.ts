import { describe, expect, it, vi } from "vitest";
import { chainToLink, forwardKinematics, parseKinematics, resolveTcpLink } from "./kinematicsLogic";
import type { KinematicModel } from "./kinematicsLogic";
import {
  applyTrajectoryPlan,
  createTrajectoryPayload,
  dispatchTrajectory,
  findActiveTrajectoryController,
  isTrajectoryController,
  planTrajectory,
  trajectoryDuration,
  trajectoryTopicFor,
  trajectoryJointNames,
  trajectoryStateTopic,
} from "./trajectoryLogic";
import type { ControllerInfo } from "./types";
import rebotarmUrdf from "./testFixtures/rebotarm-kinematics.urdf?raw";

const ARM_URDF = `
<robot name="demo_arm">
  <link name="base_link"/>
  <link name="shoulder_link"/>
  <link name="elbow_link"/>
  <link name="tool0"/>
  <joint name="joint1" type="revolute">
    <parent link="base_link"/><child link="shoulder_link"/>
    <origin xyz="0 0 0.1"/><axis xyz="0 0 1"/><limit lower="-3.14" upper="3.14"/>
  </joint>
  <joint name="joint2" type="revolute">
    <parent link="shoulder_link"/><child link="elbow_link"/>
    <origin xyz="0.3 0 0"/><axis xyz="0 1 0"/><limit lower="-1.57" upper="1.57"/>
  </joint>
  <joint name="joint3" type="revolute">
    <parent link="elbow_link"/><child link="tool0"/>
    <origin xyz="0.25 0 0"/><axis xyz="0 1 0"/><limit lower="-1.57" upper="1.57"/>
  </joint>
</robot>`;

const model: KinematicModel = parseKinematics(ARM_URDF);
const jointState = { name: ["joint1", "joint2", "joint3"], position: [0, 0, 0] };

function targetOf(q: number[]) {
  return forwardKinematics(chainToLink(model, "tool0"), q).position;
}

function controller(overrides: Partial<ControllerInfo> = {}): ControllerInfo {
  return {
    name: "arm_controller",
    typeName: "joint_trajectory_controller/JointTrajectoryController",
    state: "active",
    ...overrides,
  };
}

describe("轨迹控制器识别", () => {
  it("读取控制器声明的关节集合并兼容两种状态 Topic", () => {
    const controller = { name: "arm", topic: "/arm/joint_trajectory" };
    const topic = (name: string) => ({ name, types: ["control_msgs/msg/JointTrajectoryControllerState"] });
    expect(trajectoryStateTopic(controller, [topic("/arm/state")])).toBe("/arm/state");
    expect(trajectoryStateTopic(controller, [topic("/arm/state"), topic("/arm/controller_state")])).toBe("/arm/controller_state");
    expect(trajectoryStateTopic(controller, [])).toBe("/arm/controller_state");
    expect(trajectoryJointNames({ joint_names: ["j2", "j1"] })).toEqual(["j2", "j1"]);
    for (const data of [null, {}, { joint_names: [] }, { joint_names: ["j1", "j1"] }, { joint_names: [1] }, { joint_names: [""] }]) {
      expect(trajectoryJointNames(data)).toBeNull();
    }
  });
  it("按类型或名称识别轨迹控制器", () => {
    expect(isTrajectoryController(controller())).toBe(true);
    expect(isTrajectoryController(controller({ typeName: "forward_command_controller/ForwardCommandController", name: "traj_controller" }))).toBe(true);
    expect(isTrajectoryController(controller({ typeName: "joint_state_broadcaster/JointStateBroadcaster", name: "joint_state_broadcaster" }))).toBe(false);
  });

  it("只把 active 的轨迹控制器视为可下发", () => {
    expect(findActiveTrajectoryController([controller()])).toEqual({
      name: "arm_controller",
      topic: "/arm_controller/joint_trajectory",
    });
    expect(findActiveTrajectoryController([controller({ state: "inactive" })])).toBeNull();
    expect(findActiveTrajectoryController([])).toBeNull();
    expect(findActiveTrajectoryController([controller({ state: "finalized" })])).toBeNull();
  });

  it("多个控制器时取第一个 active 的轨迹控制器", () => {
    const controllers = [
      controller({ name: "gripper_traj", state: "inactive" }),
      controller({ name: "arm/traj" }),
    ];
    expect(findActiveTrajectoryController(controllers)?.name).toBe("arm/traj");
  });

  it("类型匹配优先于名称匹配", () => {
    const controllers = [
      controller({ name: "traj_looking_name", typeName: "forward_command_controller/ForwardCommandController" }),
      controller({ name: "arm_controller", typeName: "joint_trajectory_controller/JointTrajectoryController" }),
    ];
    expect(findActiveTrajectoryController(controllers)?.name).toBe("arm_controller");
  });

  it("Topic 名补全为 controller 命名空间下的 joint_trajectory", () => {
    expect(trajectoryTopicFor("arm_controller")).toBe("/arm_controller/joint_trajectory");
    expect(trajectoryTopicFor("arm/trajectory_controller")).toBe("/arm/trajectory_controller/joint_trajectory");
    expect(trajectoryTopicFor("/arm/trajectory_controller/")).toBe("/arm/trajectory_controller/joint_trajectory");
  });
});

describe("轨迹时长", () => {
  it("按最大关节位移估算并落在上下限内", () => {
    expect(trajectoryDuration([0], [0])).toBe(0.4);
    expect(trajectoryDuration([0], [0.6])).toBeCloseTo(1.4, 6);
    expect(trajectoryDuration([0], [100])).toBe(6);
    expect(trajectoryDuration([0, 0, 0], [0, -0.9, 0.2])).toBeCloseTo(1.9, 6);
  });
});

describe("轨迹规划", () => {
  it("使用控制器关节顺序，反馈中多余的夹爪不进入轨迹", () => {
    const result = planTrajectory({
      model, tcpLink: "", controllerJointNames: ["joint3", "joint1", "joint2"],
      jointState: { name: ["gripper", "joint1", "joint2", "joint3"], position: [0.5, 0.1, 0.2, 0.3] },
      target: targetOf([0.5, -0.4, 0.8]),
    });
    expect(result.error).toBeUndefined();
    expect(result.plan?.jointNames).toEqual(["joint3", "joint1", "joint2"]);
    expect(result.plan?.start).toEqual([0.3, 0.1, 0.2]);
    expect(result.plan?.chainIndices).toEqual([1, 2, 0]);
    expect(result.plan?.points.every((point) => point.positions.length === 3)).toBe(true);
  });

  it("控制器未就绪或不拥有 TCP 链时拒绝规划", () => {
    const options = { model, tcpLink: "", jointState, target: targetOf([0.5, -0.4, 0.8]) };
    expect(planTrajectory({ ...options, controllerJointNames: [] }).error).toMatch(/控制器关节列表/);
    expect(planTrajectory({ ...options, controllerJointNames: ["joint1", "joint1"] }).error).toMatch(/控制器关节列表/);
    expect(planTrajectory({ ...options, controllerJointNames: ["joint1", "joint2"] }).error).toMatch(/控制器不接收的关节：joint3/);
    expect(planTrajectory({ ...options, controllerJointNames: ["joint1", "joint2", "joint3", "missing"] }).error).toMatch(/JointState 缺少关节：missing/);
  });

  it("拒绝缺失、非有限或重复的反馈，不使用零补齐", () => {
    const options = { model, tcpLink: "", target: targetOf([0.5, -0.4, 0.8]) };
    for (const position of [[0], [0, NaN, 0], [0, Infinity, 0]]) {
      expect(planTrajectory({ ...options, jointState: { name: jointState.name, position } }).error).toMatch(/位置缺失或非有限/);
    }
    expect(planTrajectory({ ...options, jointState: { name: ["joint1", "joint1"], position: [0, 0] } }).error).toMatch(/重复关节名/);
    expect(planTrajectory({ ...options, jointState, target: [NaN, 0, 0] }).error).toMatch(/目标位置必须为有限/);
  });
  it("用 JointState 的关节集合并只改写 TCP 链关节", () => {
    const target = targetOf([0.5, -0.4, 0.8]);
    const result = planTrajectory({
      model,
      tcpLink: "",
      jointState: { name: ["joint1", "joint2", "joint3"], position: [0.1, 0.2, -0.1] },
      target,
    });
    expect(result.error).toBeUndefined();
    const plan = result.plan!;
    expect(plan.jointNames).toEqual(["joint1", "joint2", "joint3"]);
    expect(plan.start).toEqual([0.1, 0.2, -0.1]);
    expect(plan.chainJointNames).toEqual(["joint1", "joint2", "joint3"]);
    expect(plan.points).toHaveLength(2);
    expect(plan.points[0].positions).toEqual([0.1, 0.2, -0.1]);
    expect(plan.points[0].time_from_start).toBeGreaterThan(0);
    expect(plan.points[1].time_from_start).toBe(plan.duration);
    expect(plan.positionError).toBeLessThan(0.002);
    const solved = forwardKinematics(chainToLink(model, "tool0"), plan.goal);
    expect(solved.position[0]).toBeCloseTo(target[0], 2);
    expect(solved.position[1]).toBeCloseTo(target[1], 2);
    expect(solved.position[2]).toBeCloseTo(target[2], 2);
  });

  it("JointState 中的非链关节不进入机械臂轨迹，也不被预览改写", () => {
    const target = targetOf([0.5, -0.4, 0.8]);
    const result = planTrajectory({
      model,
      tcpLink: "tool0",
      jointState: { name: ["gripper", "joint1", "joint2", "joint3"], position: [0.42, 0, 0, 0] },
      target,
    });
    const plan = result.plan!;
    expect(plan.jointNames).toEqual(["joint1", "joint2", "joint3"]);
    expect(plan.chainIndices).toEqual([0, 1, 2]);
    const write = vi.fn();
    applyTrajectoryPlan(plan, write);
    expect(write).not.toHaveBeenCalledWith("gripper", expect.anything());
  });

  it("实际 rebotarm URDF 自动选择夹爪基座，轨迹不携带手指关节", () => {
    const arm = parseKinematics(rebotarmUrdf);
    expect(resolveTcpLink(arm)).toBe("gripper_link");
    const chain = chainToLink(arm, "gripper_link");
    const armNames = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"];
    const target = forwardKinematics(chain, [0.05, -0.03, -0.02, -0.06, -0.05, 0.06]).position;
    const result = planTrajectory({
      model: arm, tcpLink: "", target,
      jointState: { name: [...armNames, "gripper_finger_left_joint"], position: [-0.02, -0.016, -0.022, -0.065, -0.053, 0.06, 0.496] },
    });
    expect(result.error).toBeUndefined();
    expect(result.plan?.jointNames).toEqual(armNames);
    expect(result.plan?.points.every((point) => point.positions.length === 6)).toBe(true);
  });

  it("固定关节的 TCP 偏移参与 FK 与 IK，但不进入 JointTrajectory 关节列表", () => {
    const offsetModel = parseKinematics(`
      <robot name="fixed_tcp_offset">
        <link name="base"/><link name="arm"/><link name="tool0"/>
        <joint name="joint1" type="revolute">
          <parent link="base"/><child link="arm"/>
          <axis xyz="0 0 1"/><limit lower="-3.14" upper="3.14"/>
        </joint>
        <joint name="tool_fixed" type="fixed">
          <parent link="arm"/><child link="tool0"/><origin xyz="0.5 0 0"/>
        </joint>
      </robot>`);
    const fullChain = chainToLink(offsetModel, "tool0");
    const target = forwardKinematics(fullChain, [0.4]).position;
    const result = planTrajectory({
      model: offsetModel,
      tcpLink: "tool0",
      jointState: { name: ["joint1"], position: [0] },
      target,
    });

    expect(result.error).toBeUndefined();
    expect(result.plan?.chainJointNames).toEqual(["joint1"]);
    expect(result.plan?.jointNames).toEqual(["joint1"]);
    expect(result.plan?.positionError).toBeLessThan(0.002);
    expect(forwardKinematics(fullChain, result.plan!.chainGoal).position[0]).toBeCloseTo(target[0], 2);
    expect(forwardKinematics(fullChain, result.plan!.chainGoal).position[1]).toBeCloseTo(target[1], 2);
  });

  it("拖拽热启动时用上一帧 IK 解作为种子", () => {
    const target = targetOf([0.5, -0.4, 0.8]);
    const first = planTrajectory({ model, tcpLink: "", jointState, target });
    expect(first.plan?.chainGoal).toHaveLength(3);
    const second = planTrajectory({
      model,
      tcpLink: "",
      jointState,
      target: targetOf([0.52, -0.38, 0.78]),
      seed: first.plan?.chainGoal,
    });
    expect(second.error).toBeUndefined();
  });

  it("JointState 未就绪或缺少链关节时报错", () => {
    expect(planTrajectory({ model, tcpLink: "", jointState: null, target: [0, 0, 0] }).error).toMatch(/JointState 尚未就绪/);
    expect(planTrajectory({ model, tcpLink: "", jointState: { name: [], position: [] }, target: [0, 0, 0] }).error).toMatch(/JointState 尚未就绪/);
    expect(planTrajectory({
      model,
      tcpLink: "",
      jointState: { name: ["joint1"], position: [0] },
      target: [0, 0, 0],
    }).error).toMatch(/JointState 缺少关节：joint2、joint3/);
  });

  it("TCP link 配置非法时报错", () => {
    expect(planTrajectory({ model, tcpLink: "nope", jointState, target: [0, 0, 0] }).error).toMatch(/配置的 TCP link 不存在/);
  });

  it("目标不可达时返回未收敛原因且不隐藏 plan", () => {
    const result = planTrajectory({ model, tcpLink: "", jointState, target: [5, 5, 5] });
    expect(result.error).toMatch(/IK 未收敛/);
    expect(result.plan?.positionError).toBeGreaterThan(0.5);
  });

  it("自动解析 TCP link", () => {
    expect(resolveTcpLink(model)).toBe("tool0");
  });
});

describe("轨迹消息构造", () => {
  it("生成 Bridge 轨迹指令负载", () => {
    const payload = createTrajectoryPayload(
      ["joint1", "joint2"],
      [{ positions: [0, 0], time_from_start: 0.1 }, { positions: [0.5, -0.2], time_from_start: 1.2 }],
    );
    expect(payload).toEqual({
      op: "trajectory_command",
      joint_names: ["joint1", "joint2"],
      trajectory_points: [
        { positions: [0, 0], velocities: [], time_from_start: 0.1 },
        { positions: [0.5, -0.2], velocities: [], time_from_start: 1.2 },
      ],
    });
  });

  it("保留显式速度字段", () => {
    const payload = createTrajectoryPayload(
      ["joint1"],
      [{ positions: [0.1], velocities: [0.2], time_from_start: 1 }],
    );
    expect(payload.trajectory_points[0].velocities).toEqual([0.2]);
  });
});

describe("松手下发", () => {
  const send = vi.fn().mockResolvedValue(undefined);

  it("规划成功后调用 send，并携带 JointState 的关节集合和两点轨迹", async () => {
    send.mockClear();
    const outcome = await dispatchTrajectory({
      model,
      tcpLink: "",
      jointState: { name: ["joint1", "joint2", "joint3"], position: [0.1, 0, 0] },
      target: targetOf([0.5, -0.4, 0.8]),
      send,
    });
    expect(outcome.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      jointNames: ["joint1", "joint2", "joint3"],
      points: outcome.plan!.points,
    });
    expect(outcome.plan!.points[0].positions).toEqual([0.1, 0, 0]);
  });

  it("IK 未收敛时不调用 send 并返回原因", async () => {
    send.mockClear();
    const outcome = await dispatchTrajectory({
      model,
      tcpLink: "",
      jointState,
      target: [5, 5, 5],
      send,
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toMatch(/IK 未收敛/);
    expect(send).not.toHaveBeenCalled();
  });

  it("JointState 未就绪时不调用 send", async () => {
    send.mockClear();
    const outcome = await dispatchTrajectory({ model, tcpLink: "", jointState: null, target: [0, 0, 0], send });
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toMatch(/JointState 尚未就绪/);
    expect(send).not.toHaveBeenCalled();
  });

  it("send 抛错时返回 rejected 并保留 plan", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("轨迹控制器订阅不可用"));
    const outcome = await dispatchTrajectory({
      model,
      tcpLink: "",
      jointState,
      target: targetOf([0.5, -0.4, 0.8]),
      send: failing,
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.error).toMatch(/轨迹下发失败：轨迹控制器订阅不可用/);
    expect(outcome.plan?.jointNames).toEqual(["joint1", "joint2", "joint3"]);
  });
});

describe("可视化关节写回", () => {
  it("按 JointState 顺序写回全部关节值", () => {
    const result = planTrajectory({ model, tcpLink: "", jointState, target: targetOf([0.5, -0.4, 0.8]) });
    const written = new Map<string, number>();
    applyTrajectoryPlan(result.plan!, (name, value) => written.set(name, value));
    expect([...written.keys()]).toEqual(["joint1", "joint2", "joint3"]);
    expect(written.get("joint1")).toBeCloseTo(result.plan!.goal[0], 9);
  });

  it("可指定写回的关节值数组", () => {
    const result = planTrajectory({ model, tcpLink: "", jointState, target: targetOf([0.5, -0.4, 0.8]) });
    const written = new Map<string, number>();
    applyTrajectoryPlan(result.plan!, (name, value) => written.set(name, value), [1, 2, 3]);
    expect([...written.values()]).toEqual([1, 2, 3]);
  });
});
