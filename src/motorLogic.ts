export type CommandMode = 0 | 1 | 2 | 3;
export type CommandValues = { position: number; velocity: number; kp: number; kd: number; effort: number };
export type CommandInput = Record<keyof CommandValues, string>;
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

export function parseCommandValues(input: CommandInput): { values?: CommandValues; error?: string } {
  const fields = [
    ["Position", input.position], ["Velocity", input.velocity], ["Kp", input.kp],
    ["Kd", input.kd], ["Effort", input.effort],
  ] as const;
  const parsed: number[] = [];
  for (const [label, raw] of fields) {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) return { error: `${label} 请输入有效数字` };
    parsed.push(value);
  }
  if (Math.abs(parsed[4]) > 1) return { error: "Effort 必须在 -1 到 1 之间" };
  return { values: { position: parsed[0], velocity: parsed[1], kp: parsed[2], kd: parsed[3], effort: parsed[4] } };
}

export function createCommandPayload(mode: CommandMode, values?: CommandValues) {
  return {
    op: "joint_command", mode,
    position: values?.position ?? 0, velocity: values?.velocity ?? 0,
    kp: values?.kp ?? 0, kd: values?.kd ?? 0, effort: values?.effort ?? 0,
    confirmation: mode === 3 ? "" : "ARMED",
  };
}

export function faultInfo(code: number): FaultInfo {
  return motorFaults[code] ?? { name: "UNKNOWN", description: "未知 STM32 故障，请检查固件日志和 fault code 定义" };
}
