import type { MotorControlCapabilities } from "./types";

const errors = ["无错误", "请求参数无效", "启动身份或配置代次不匹配", "尚未确认关闭输出", "控制事务忙碌", "所选轴不支持此模式", "驱动模式不匹配", "控制租约无效或已过期", "指令序号过期", "参数不是有限数值", "超出固件已验证范围", "固件故障", "寄存器写入或读回不匹配", "寄存器操作超时"];
export function motorModeError(code: number): string {
  return `${code}（${errors[code] ?? "未知错误，请保留原始码"}）`;
}
export function motorAxisNames(mask: number, names: string[] = []): string {
  return Array.from({ length: 7 }, (_, i) => i).filter(i => mask & (1 << i))
    .map(i => names[i] && names[i] !== `joint${i + 1}` ? `joint${i + 1}（${names[i]}）` : `joint${i + 1}`).join("、");
}
export function motorModeEvidence(value: MotorControlCapabilities): string {
  return `boot=${value.boot_id} · epoch=${value.control_epoch} · operation=${value.operation_id} · ${["空闲", "进行中", "成功", "失败", "已取消"][value.operation_state] ?? "未知状态"} · error=${motorModeError(value.error_code)} · fault=${value.fault_code} · reject=${motorModeError(value.reject_code)} · mask=${value.selected_joint_mask} · 实际模式=${value.control_modes.join("/")} · 输出关闭=${value.disabled_verified ? "已核验" : "未核验"}`;
}
export function motorModeFailure(value: MotorControlCapabilities | null): string | null {
  if (!value?.supported || !value.fresh || ![3, 4].includes(value.operation_state)) return null;
  return `固件模式事务 #${value.operation_id} ${value.operation_state === 3 ? "失败" : "已取消"}：${motorModeError(value.error_code)}。${value.error_code === 10 ? "切换 POS_VEL 前，固件会校验当前位置是否在已验证范围内；请核对下方范围与反馈，不会自动移动或放宽限位。" : "请保留日志，核验输出关闭后再处理。"}`;
}
export function motorFirmwareRanges(value: MotorControlCapabilities, mask: number): string {
  return Array.from({ length: 7 }, (_, i) => i).filter(i => mask & (1 << i)).map(i =>
    `joint${i + 1}：${formatMotorNumber(value.position_min[i])} 至 ${formatMotorNumber(value.position_max[i])} rad；速度上限 ${formatMotorNumber(value.velocity_limit_max[i])} rad/s`).join("；");
}
export function formatMotorNumber(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? Number(value.toFixed(6)).toString() : "未知";
}
export type MotorModeLogEntry = { at: string; message: string };
export const MOTOR_MODE_LOG_LIMIT = 100;
export function appendMotorModeLog(entries: MotorModeLogEntry[], message: string, at = new Date().toISOString()): MotorModeLogEntry[] {
  return [...entries, { at, message: message.slice(0, 4000) }].slice(-MOTOR_MODE_LOG_LIMIT);
}
