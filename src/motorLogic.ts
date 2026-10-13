export type CommandMode = 0 | 1 | 2 | 3;
export type SharedCommandInput = {
  velocity: string;
  kp: string;
  kd: string;
  effort: string;
};
export type MotorRowInput = {
  enabled: boolean;
  position: string;
  min: string;
  max: string;
};
export type CommandValues = {
  positions: number[];
  active_joint_mask: number;
  velocity: number;
  kp: number;
  kd: number;
  effort: number;
};
export type FaultInfo = { name: string; description: string };

export const modes: { value: CommandMode; label: string; description: string }[] = [
  { value: 0, label: "HOLD", description: "锁存当前位置并使用 Kp/Kd 保持" },
  { value: 1, label: "TRACK", description: "MIT 跟踪 position/velocity/kp/kd/effort" },
  { value: 2, label: "RETURN", description: "MIT 跟踪返回目标，通常设为 0 rad" },
  { value: 3, label: "DISABLE", description: "立即撤销电机使能" },
];

export const DEFAULT_MODE: CommandMode = 1;
export const DEFAULT_KP = "8";
export const DEFAULT_KD = "2";
export const DEFAULT_TRAVEL = 0.35;
export const DEFAULT_JOINT_COUNT = 6;
const decimalPattern = /^-?\d*(?:\.\d*)?$/;

export const motorFaults: Record<number, FaultInfo> = {
  0: { name: "NONE", description: "无故障" },
  1: { name: "INVALID_MODE", description: "命令模式无效" },
  2: { name: "NONFINITE_COMMAND", description: "指令包含 NaN 或 Infinity 等非有限数值" },
  3: { name: "COMMAND_LIMIT", description: "指令超过 STM32 固件中的 Position、Velocity、Kp、Kd 或 Effort 限制" },
  4: { name: "STALE_SEQUENCE", description: "命令序列号不是更新的序列" },
  5: { name: "INACTIVE_JOINT_COMMAND", description: "未激活关节的命令字段不为零" },
  6: { name: "FEEDBACK_TIMEOUT", description: "电机反馈超时" },
  7: { name: "DRIVE", description: "电机驱动器报告故障" },
  8: { name: "CAN_TX", description: "FDCAN 指令发送失败" },
  9: { name: "INIT", description: "电机初始化或 MIT 模式切换失败" },
  10: { name: "ENABLE_TIMEOUT", description: "电机使能超时" },
  11: { name: "COMMAND_LOSS_LATCHED", description: "控制指令中断已锁存，需要重启 STM32 才能恢复" },
};

export function normalizeDecimal(value: string): string | null {
  const normalized = value.replace(",", ".");
  return decimalPattern.test(normalized) ? normalized : null;
}

export function jointLabel(index: number): string {
  return `joint${index + 1}`;
}

export function createDefaultMotors(count = DEFAULT_JOINT_COUNT): MotorRowInput[] {
  return Array.from({ length: count }, () => ({
    enabled: false,
    position: "0",
    min: String(-DEFAULT_TRAVEL),
    max: String(DEFAULT_TRAVEL),
  }));
}

/** Expand or trim motor rows when JointState length changes; preserve edits. */
export function resizeMotors(motors: MotorRowInput[], count: number): MotorRowInput[] {
  const target = Math.max(1, Math.min(32, count));
  if (motors.length === target) return motors;
  if (motors.length > target) return motors.slice(0, target);
  return [...motors, ...createDefaultMotors(target - motors.length)];
}

export function buildActiveJointMask(enabled: boolean[]): number {
  let mask = 0;
  for (let index = 0; index < enabled.length && index < 32; index += 1) {
    if (enabled[index]) mask |= 1 << index;
  }
  return mask;
}

export function parseTravelBound(raw: string, label: string): { value?: number; error?: string } {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) return { error: `${label} 请输入有效数字` };
  return { value };
}

export function parseCommandValues(
  shared: SharedCommandInput,
  motors: Pick<MotorRowInput, "enabled" | "position">[],
): { values?: CommandValues; error?: string } {
  const sharedFields = [
    ["Velocity", shared.velocity],
    ["Kp", shared.kp],
    ["Kd", shared.kd],
    ["Effort", shared.effort],
  ] as const;
  const sharedParsed: number[] = [];
  for (const [label, raw] of sharedFields) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) return { error: `${label} 请输入有效数字` };
    sharedParsed.push(value);
  }
  if (Math.abs(sharedParsed[3]) > 1) return { error: "Effort 必须在 -1 到 1 之间" };

  const enabledIndexes = motors
    .map((motor, index) => (motor.enabled ? index : -1))
    .filter((index) => index >= 0);
  if (enabledIndexes.length === 0) return { error: "请至少使能一个电机" };

  const positions = motors.map(() => 0);
  for (const index of enabledIndexes) {
    const raw = motors[index].position;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) {
      return { error: `${jointLabel(index)} Position 请输入有效数字` };
    }
    positions[index] = value;
  }

  return {
    values: {
      positions,
      active_joint_mask: buildActiveJointMask(motors.map((motor) => motor.enabled)),
      velocity: sharedParsed[0],
      kp: sharedParsed[1],
      kd: sharedParsed[2],
      effort: sharedParsed[3],
    },
  };
}

export function createCommandPayload(mode: CommandMode, values?: CommandValues) {
  if (mode === 3 || !values) {
    return {
      op: "joint_command" as const,
      mode,
      position: [] as number[],
      velocity: 0,
      kp: 0,
      kd: 0,
      effort: 0,
      active_joint_mask: 0,
      confirmation: "",
    };
  }
  return {
    op: "joint_command" as const,
    mode,
    position: values.positions,
    velocity: values.velocity,
    kp: values.kp,
    kd: values.kd,
    effort: values.effort,
    active_joint_mask: values.active_joint_mask,
    confirmation: "ARMED",
  };
}

export function faultInfo(code: number): FaultInfo {
  return motorFaults[code] ?? { name: "UNKNOWN", description: "未知 STM32 故障，请检查固件日志和 fault code 定义" };
}

