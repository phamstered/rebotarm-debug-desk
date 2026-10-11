import { describe, expect, it } from "vitest";
import {
  actuatedJoints,
  applyPoint,
  cameraFacingNormal,
  chainToLink,
  clampToLimits,
  forwardKinematics,
  identity4,
  IK_POSITION_TOLERANCE,
  intersectRayPlane,
  matToQuat,
  mul4,
  parseKinematics,
  resolveTcpLink,
  rotationFromAxisAngle,
  rotationFromRpy,
  sceneToUrdfPoint,
  solveLinear3,
  solvePositionIk,
  urdfToScenePoint,
} from "./kinematicsLogic";
import type { KinematicModel, Vec3 } from "./kinematicsLogic";

const ARM_URDF = `
<robot name="demo_arm">
  <link name="base_link"/>
  <link name="shoulder_link"/>
  <link name="elbow_link"/>
  <link name="wrist_link"/>
  <link name="tool0"/>
  <link name="camera_mount"/>
  <joint name="joint1" type="revolute">
    <parent link="base_link"/><child link="shoulder_link"/>
    <origin xyz="0 0 0.1" rpy="0 0 0"/><axis xyz="0 0 1"/>
    <limit lower="-3.14" upper="3.14" effort="10" velocity="1"/>
  </joint>
  <joint name="joint2" type="revolute">
    <parent link="shoulder_link"/><child link="elbow_link"/>
    <origin xyz="0.3 0 0" rpy="0 0 0"/><axis xyz="0 1 0"/>
    <limit lower="-1.57" upper="1.57" effort="10" velocity="1"/>
  </joint>
  <joint name="joint3" type="revolute">
    <parent link="elbow_link"/><child link="wrist_link"/>
    <origin xyz="0.25 0 0" rpy="0 0 0"/><axis xyz="0 1 0"/>
    <limit lower="-1.57" upper="1.57" effort="10" velocity="1"/>
  </joint>
  <joint name="wrist_fixed" type="fixed">
    <parent link="wrist_link"/><child link="tool0"/>
    <origin xyz="0.08 0 0" rpy="0 0 0"/>
  </joint>
  <joint name="camera_fixed" type="fixed">
    <parent link="wrist_link"/><child link="camera_mount"/>
    <origin xyz="0 0 0.05" rpy="0 0 0"/>
  </joint>
</robot>`;

function model(): KinematicModel {
  return parseKinematics(ARM_URDF);
}

function near(actual: number, expected: number, tolerance = 1e-9) {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
}

function expectVec3(actual: Vec3, expected: Vec3, tolerance = 1e-9) {
  near(actual[0], expected[0], tolerance);
  near(actual[1], expected[1], tolerance);
  near(actual[2], expected[2], tolerance);
}

describe("矩阵工具", () => {
  it("单位矩阵左乘不改变向量", () => {
    expectVec3(applyPoint(identity4(), [1, 2, 3]), [1, 2, 3]);
  });

  it("固定轴 XYZ 欧拉角等价于 Rz·Ry·Rx 组合", () => {
    const combined = mul4(
      mul4(rotationFromRpy([0, 0, 0.3]), rotationFromRpy([0, 0.2, 0])),
      rotationFromRpy([0.1, 0, 0]),
    );
    const single = rotationFromRpy([0.1, 0.2, 0.3]);
    single.forEach((value, index) => near(value, combined[index], 1e-12));
  });

  it("rpy 只有 yaw 时把 X 轴转到 Y 轴", () => {
    expectVec3(applyPoint(rotationFromRpy([0, 0, Math.PI / 2]), [1, 0, 0]), [0, 1, 0], 1e-12);
  });

  it("轴角旋转符合右手定则", () => {
    expectVec3(applyPoint(rotationFromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]), [0, 1, 0], 1e-12);
    expectVec3(applyPoint(rotationFromAxisAngle([0, 1, 0], Math.PI / 2), [0, 0, 1]), [1, 0, 0], 1e-12);
  });

  it("矩阵转四元数还原纯 yaw 旋转", () => {
    const quaternion = matToQuat(rotationFromRpy([0, 0, Math.PI / 2]));
    near(quaternion[0], 0, 1e-12);
    near(quaternion[1], 0, 1e-12);
    near(quaternion[2], Math.SQRT1_2, 1e-12);
    near(quaternion[3], Math.SQRT1_2, 1e-12);
  });

  it("求解 3x3 线性方程组并识别奇异矩阵", () => {
    const solution = solveLinear3([2, 0, 0, 0, 4, 0, 0, 0, 5], [2, 8, 15]);
    expect(solution).not.toBeNull();
    expectVec3(solution as Vec3, [1, 2, 3], 1e-12);
    expect(solveLinear3([1, 2, 3, 2, 4, 6, 1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe("URDF 解析", () => {
  it("解析关节原点、轴和限位", () => {
    const parsed = model();
    expect(parsed.rootLink).toBe("base_link");
    expect(parsed.links).toEqual(["base_link", "shoulder_link", "elbow_link", "wrist_link", "tool0", "camera_mount"]);
    const joint2 = parsed.joints.find((joint) => joint.name === "joint2");
    expect(joint2?.type).toBe("revolute");
    expect(joint2?.parent).toBe("shoulder_link");
    expect(joint2?.child).toBe("elbow_link");
    expect(joint2?.origin).toEqual([0.3, 0, 0]);
    expect(joint2?.axis).toEqual([0, 1, 0]);
    expect(joint2?.lower).toBe(-1.57);
    expect(joint2?.upper).toBe(1.57);
  });

  it("固定关节没有限位并且不参与正解关节数", () => {
    const parsed = model();
    const fixed = parsed.joints.find((joint) => joint.name === "wrist_fixed");
    expect(fixed?.type).toBe("fixed");
    expect(Number.isFinite(fixed?.lower as number)).toBe(false);
    const chain = chainToLink(parsed, "tool0");
    expect(chain.map((joint) => joint.name)).toEqual(["joint1", "joint2", "joint3", "wrist_fixed"]);
    expect(actuatedJoints(chain).map((joint) => joint.name)).toEqual(["joint1", "joint2", "joint3"]);
  });

  it("缺失限位的 revolute 关节退化为不限位", () => {
    const parsed = parseKinematics(`
      <robot name="bare">
        <link name="a"/><link name="b"/>
        <joint name="j" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 0 1"/></joint>
      </robot>`);
    const joint = parsed.joints[0];
    expect(joint.lower).toBe(Number.NEGATIVE_INFINITY);
    expect(clampToLimits(joint, 12)).toBe(12);
  });

  it("拒绝非法 XML 与空 URDF", () => {
    expect(() => parseKinematics("<robot><link")).toThrow(/解析失败/);
    expect(() => parseKinematics('<robot name="x"></robot>')).toThrow(/没有可用的 link/);
  });

  it("链查询校验 link 是否存在", () => {
    expect(() => chainToLink(model(), "missing_link")).toThrow(/不存在 link/);
  });
});

describe("TCP link 解析", () => {
  it("显式配置优先", () => {
    expect(resolveTcpLink(model(), "camera_mount")).toBe("camera_mount");
  });

  it("显式配置指向不存在的 link 时报错", () => {
    expect(() => resolveTcpLink(model(), "not_a_link")).toThrow(/配置的 TCP link 不存在/);
  });

  it("未配置时优先选择命名匹配的叶子 link", () => {
    expect(resolveTcpLink(model())).toBe("tool0");
  });

  it("命名都不匹配时选择运动链最深的叶子 link", () => {
    const parsed = parseKinematics(`
      <robot name="deep">
        <link name="root"/><link name="mid"/><link name="tip"/><link name="stub"/>
        <joint name="j1" type="revolute"><parent link="root"/><child link="mid"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>
        <joint name="j2" type="revolute"><parent link="mid"/><child link="tip"/><axis xyz="0 0 1"/><limit lower="-1" upper="1"/></joint>
        <joint name="j3" type="fixed"><parent link="root"/><child link="stub"/></joint>
      </robot>`);
    expect(resolveTcpLink(parsed)).toBe("tip");
  });
});

describe("正运动学", () => {
  it("全零关节位姿由关节原点累积得到", () => {
    const chain = chainToLink(model(), "tool0");
    const frame = forwardKinematics(chain, [0, 0, 0]);
    expectVec3(frame.position, [0.63, 0, 0.1], 1e-12);
  });

  it("绕 Z 轴旋转 90 度后末端沿 Y 轴", () => {
    const chain = chainToLink(model(), "tool0");
    const frame = forwardKinematics(chain, [Math.PI / 2, 0, 0]);
    expectVec3(frame.position, [0, 0.63, 0.1], 1e-12);
  });

  it("revolute 关节绕 Y 轴俯仰", () => {
    const chain = chainToLink(model(), "tool0");
    // joint2 在肩部前 0.3 m，绕 Y 轴转 90° 后后续连杆沿 -Z 下折。
    const frame = forwardKinematics(chain, [0, Math.PI / 2, 0]);
    expectVec3(frame.position, [0.3, 0, -0.23], 1e-12);
  });

  it("prismatic 关节沿归一化轴平移", () => {
    const parsed = parseKinematics(`
      <robot name="slider">
        <link name="base"/><link name="carriage"/>
        <joint name="slide" type="prismatic">
          <parent link="base"/><child link="carriage"/>
          <origin xyz="0 0 0"/><axis xyz="0 0 2"/><limit lower="0" upper="1"/>
        </joint>
      </robot>`);
    const chain = chainToLink(parsed, "carriage");
    expectVec3(forwardKinematics(chain, [0.25]).position, [0, 0, 0.25], 1e-12);
  });
});

describe("位置逆运动学", () => {
  const targetOf = (q: number[]): Vec3 => forwardKinematics(chainToLink(model(), "tool0"), q).position;

  it("收敛到正解映射出的可达目标并满足关节限位", () => {
    const chain = chainToLink(model(), "tool0");
    const target = targetOf([0.5, -0.4, 0.8]);
    const result = solvePositionIk(chain, [0.1, 0.2, -0.1], target);
    expect(result.reached).toBe(true);
    expect(result.positionError).toBeLessThan(0.002);
    expectVec3(forwardKinematics(chain, result.positions).position, target, 0.002);
    const joints = actuatedJoints(chain);
    result.positions.forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(joints[index].lower - 1e-9);
      expect(value).toBeLessThanOrEqual(joints[index].upper + 1e-9);
    });
  });

  it("种子偏离较大时仍能收敛到目标位置", () => {
    const chain = chainToLink(model(), "tool0");
    const target = targetOf([-1.2, 1.1, -0.9]);
    const result = solvePositionIk(chain, [0, 0, 0], target);
    expect(result.reached).toBe(true);
    expectVec3(forwardKinematics(chain, result.positions).position, target, 0.002);
  });

  it("目标靠近关节限位时也能收敛", () => {
    const chain = chainToLink(model(), "tool0");
    const target = targetOf([3.0, 1.5, -1.5]);
    const result = solvePositionIk(chain, [0, 0, 0], target);
    expect(result.reached).toBe(true);
    expectVec3(forwardKinematics(chain, result.positions).position, target, 0.002);
  });

  it("热启动（拖拽逐帧调用）只需少量迭代", () => {
    const chain = chainToLink(model(), "tool0");
    const first = solvePositionIk(chain, [0, 0, 0], targetOf([0.4, -0.3, 0.6]));
    const second = solvePositionIk(chain, first.positions, targetOf([0.42, -0.28, 0.62]));
    expect(second.reached).toBe(true);
    expect(second.iterations).toBeLessThan(first.iterations + 6);
  });

  it("默认位置阈值为 5 mm，并可通过 tolerance 覆盖", () => {
    expect(IK_POSITION_TOLERANCE).toBe(0.005);
    const chain = chainToLink(model(), "tool0");
    const target = targetOf([0.5, -0.4, 0.8]);
    // 只迭代一次，得到确定的中间残差，用来验证 reached 完全由 tolerance 决定。
    const strict = solvePositionIk(chain, [0, 0, 0], target, { maxIterations: 1, tolerance: 1e-12 });
    expect(strict.reached).toBe(false);
    const loose = solvePositionIk(chain, [0, 0, 0], target, { maxIterations: 1, tolerance: 1 });
    expect(loose.reached).toBe(true);
  });

  it("不可达目标返回失败且关节值仍在限位内", () => {
    const chain = chainToLink(model(), "tool0");
    const result = solvePositionIk(chain, [0, 0, 0], [5, 5, 5]);
    expect(result.reached).toBe(false);
    expect(result.positionError).toBeGreaterThan(0.5);
    const joints = actuatedJoints(chain);
    result.positions.forEach((value, index) => {
      expect(value).toBeGreaterThanOrEqual(joints[index].lower - 1e-9);
      expect(value).toBeLessThanOrEqual(joints[index].upper + 1e-9);
    });
  });

  it("关节限位把可达域之外的目标判为未收敛", () => {
    const chain = chainToLink(model(), "tool0");
    // 该机械臂在 joint2/joint3 ∈ ±1.57 下无法把 TCP 拉到 r≈0.495、z=0.1 的位置。
    const result = solvePositionIk(chain, [0.1, 0.2, -0.1], [0.35, 0.35, 0.1]);
    expect(result.reached).toBe(false);
    expect(result.positionError).toBeGreaterThan(0.01);
  });

  it("只有固定关节的链不做任何关节调整", () => {
    const parsed = parseKinematics(`
      <robot name="rigid">
        <link name="base"/><link name="tip"/>
        <joint name="mount" type="fixed"><parent link="base"/><child link="tip"/><origin xyz="1 0 0"/></joint>
      </robot>`);
    const chain = chainToLink(parsed, "tip");
    const result = solvePositionIk(chain, [], [2, 0, 0]);
    expect(result.positions).toEqual([]);
    expect(result.reached).toBe(false);
  });
});

describe("拖拽坐标换算", () => {
  it("URDF 与 Three.js 场景坐标互为逆变换", () => {
    const point: Vec3 = [0.3, -0.2, 0.5];
    expectVec3(sceneToUrdfPoint(urdfToScenePoint(point)), point, 1e-12);
    expectVec3(urdfToScenePoint([1, 2, 3]), [1, 3, -2], 1e-12);
  });

  it("相机正对平面给出归一化法向", () => {
    const normal = cameraFacingNormal([0, 5, 0], [0, 0, 0]);
    expectVec3(normal, [0, 1, 0], 1e-12);
  });

  it("射线与正交平面求交", () => {
    const hit = intersectRayPlane([0, 5, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0]);
    expectVec3(hit as Vec3, [0, 0, 0], 1e-12);
  });

  it("平行射线与背向射线不产生交点", () => {
    expect(intersectRayPlane([0, 5, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeNull();
    expect(intersectRayPlane([0, 5, 0], [0, 1, 0], [0, 0, 0], [0, 1, 0])).toBeNull();
  });
});
