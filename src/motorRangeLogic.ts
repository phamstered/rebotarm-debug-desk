export type MotorRange = {
  min: number | null;
  max: number | null;
  source: string;
  reason?: string;
};

type JointRange = { type: string; range: MotorRange };
export type MotorUrdfRanges = {
  joints: ReadonlyMap<string, JointRange>;
  error?: string;
};

const GRIPPER_JOINT = "gripper_finger_left_joint";
const MICRO_ROS_PLUGIN = "microros_stm32h723_bridge/MicroRosSystem";
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function unknown(reason: string): MotorRange {
  return { min: null, max: null, source: "范围未知", reason };
}

// Only direct, expanded URDF elements count. In particular, ros2_control joints
// and unexpanded xacro branches must not become model joints or calibration.
function children(element: Element, tag: string): Element[] {
  return Array.from(element.children).filter(child => child.tagName === tag);
}

function finiteNumber(value: string | null | undefined): number | null {
  const text = value?.trim();
  if (!text || !decimal.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parameter(element: Element, name: string): number | null {
  const matches = children(element, "param").filter(param => param.getAttribute("name") === name);
  return matches.length === 1 ? finiteNumber(matches[0].textContent) : null;
}

function gripperRange(robot: Element, lower: number, upper: number): MotorRange {
  const controls = children(robot, "ros2_control").filter(control => (
    children(control, "joint").some(joint => joint.getAttribute("name") === GRIPPER_JOINT)
  ));
  if (controls.length !== 1) return unknown("夹爪缺少唯一的 ros2_control 标定映射；不能把米制限位当作 rad");
  const hardware = children(controls[0], "hardware");
  const plugins = hardware.length === 1 ? children(hardware[0], "plugin") : [];
  if (plugins.length !== 1 || plugins[0].textContent?.trim() !== MICRO_ROS_PLUGIN) {
    return unknown("夹爪缺少唯一的 MicroRosSystem 标定映射；不能把米制限位当作 rad");
  }
  const scale = parameter(hardware[0], "gripper_position_scale");
  const offset = parameter(hardware[0], "gripper_position_offset");
  // Match MicroRosSystem's calibration admission, including near-zero scales.
  if (scale === null || Math.abs(scale) < 1e-12 || offset === null) {
    return unknown("夹爪标定 scale/offset 缺失或无效；不能把米制限位当作 rad");
  }
  const joints = children(controls[0], "joint").filter(joint => joint.getAttribute("name") === GRIPPER_JOINT);
  const positions = joints.length === 1
    ? children(joints[0], "command_interface").filter(command => command.getAttribute("name") === "position")
    : [];
  if (positions.length !== 1) return unknown("夹爪缺少唯一的 position 标定行程");
  const calibratedMin = parameter(positions[0], "min");
  const calibratedMax = parameter(positions[0], "max");
  if (calibratedMin === null || calibratedMax === null || calibratedMin >= calibratedMax) {
    return unknown("夹爪 position 标定行程缺失或无效");
  }
  const boundedMin = Math.max(lower, calibratedMin);
  const boundedMax = Math.min(upper, calibratedMax);
  if (boundedMin >= boundedMax) return unknown("URDF 限位与夹爪标定行程没有有效交集");
  // q_m = scale * q_raw + offset. A negative scale reverses the endpoints.
  const first = (boundedMin - offset) / scale;
  const second = (boundedMax - offset) / scale;
  const min = Math.min(first, second), max = Math.max(first, second);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return unknown("夹爪标定换算未得到有效的 rad 范围");
  }
  return { min, max, source: "URDF · 标定换算" };
}

/** Parse the current connection's expanded URDF once; never supply default bounds. */
export function parseMotorUrdfRanges(xml: string): MotorUrdfRanges {
  const joints = new Map<string, JointRange>();
  if (!xml.trim()) return { joints, error: "尚未收到当前连接的 URDF" };
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const robot = document.documentElement;
  if (document.getElementsByTagName("parsererror").length || robot?.tagName !== "robot") {
    return { joints, error: "URDF XML 无效" };
  }
  for (const joint of children(robot, "joint")) {
    const name = joint.getAttribute("name");
    if (!name) continue;
    const type = joint.getAttribute("type") ?? "";
    let range: MotorRange;
    if (joints.has(name)) {
      range = unknown(`URDF 关节名 ${name} 重复`);
    } else if (children(joint, "mimic").length) {
      range = unknown("mimic 关节不能作为独立电机行程");
    } else if (type !== "revolute" && type !== "prismatic") {
      range = unknown(type === "continuous" ? "连续关节没有有限的 URDF 行程" : "该 URDF 关节不提供独立电机行程");
    } else {
      const limits = children(joint, "limit");
      const lower = limits.length === 1 ? finiteNumber(limits[0].getAttribute("lower")) : null;
      const upper = limits.length === 1 ? finiteNumber(limits[0].getAttribute("upper")) : null;
      if (lower === null || upper === null || lower >= upper) {
        range = unknown("URDF 缺少唯一、有限且递增的 lower/upper 限位");
      } else if (type === "revolute") {
        range = { min: lower, max: upper, source: "URDF" };
      } else {
        range = name === GRIPPER_JOINT ? gripperRange(robot, lower, upper)
          : unknown("直线关节缺少原始电机 rad 标定映射");
      }
    }
    joints.set(name, { type, range });
  }
  return { joints };
}

/** Resolve by exact feedback name, with jointN used only when no name exists. */
export function motorRangeFor(model: MotorUrdfRanges, name: string, index: number): MotorRange {
  if (model.error) return unknown(model.error);
  const resolvedName = name || `joint${index + 1}`;
  const joint = model.joints.get(resolvedName);
  if (!joint) return unknown(`URDF 未定义关节 ${resolvedName}`);
  if (joint.type === "prismatic" && index !== 6) return unknown("直线关节与 joint7 原始电机通道不匹配");
  return joint.range;
}
