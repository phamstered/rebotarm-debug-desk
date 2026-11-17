import type { BridgeEnvelope, MotorControlCapabilities, MotorDriveMode } from "./types";
import { buildActiveJointMask, type MotorRowInput } from "./motorLogic";

export const POS_VEL_JOINT_COUNT = 7;
export type PosVelValues = { position: number[]; velocityLimit: number[]; mask: number };
export type MotorEvidenceWatermark = { boot: string; epoch: number; stamp: bigint; retiredBoots: string[] };

/** Preserve source high watermarks across stale/unsupported responses. */
export function acceptMotorEvidence(previous: MotorEvidenceWatermark | null, value: MotorControlCapabilities): { watermark: MotorEvidenceWatermark | null; advanced: boolean; error?: string } {
  const unchanged = { watermark: previous, advanced: false };
  if (!value.supported || !value.fresh) return unchanged;
  let boot: bigint, stamp: bigint;
  try { boot = BigInt(value.boot_id); stamp = BigInt(value.stamp_ns); } catch { return { ...unchanged, error: "驱动身份 / 源时间戳无效" }; }
  if (boot <= 0n || stamp <= 0n || !Number.isInteger(value.control_epoch) || value.control_epoch < 0 || value.control_epoch > 0xffffffff
    || !Number.isFinite(value.age_ms) || value.age_ms < 0 || value.age_ms >= 1000) return { ...unchanged, error: "驱动状态无效或过期" };
  if (previous && (previous.retiredBoots.includes(value.boot_id)
    || (previous.boot === value.boot_id && (stamp < previous.stamp || value.control_epoch < previous.epoch))
    || (previous.boot !== value.boot_id && previous.retiredBoots.length >= 16))) return { ...unchanged, error: "拒绝旧启动 / 配置代次 / 源时间戳回退；等待新鲜状态" };
  if (previous?.boot === value.boot_id && stamp === previous.stamp) return unchanged;
  return { advanced: true, watermark: { boot: value.boot_id, epoch: value.control_epoch, stamp,
    retiredBoots: previous ? [...previous.retiredBoots, ...(previous.boot !== value.boot_id ? [previous.boot] : [])] : [] } };
}

export function selectedMotorMask(rows: MotorRowInput[]): number {
  return buildActiveJointMask(rows.map(row => row.enabled)) >>> 0;
}

export function actualDriveMode(capabilities: MotorControlCapabilities | null, mask: number): string {
  if (!capabilities?.supported) return "MIT（旧协议，未提供驱动读回）";
  if (!capabilities.fresh) return "未知（反馈过期）";
  if (!mask) return "请选择控制轴";
  const modes = capabilities.control_modes.filter((_, index) => (mask & (1 << index)) !== 0);
  if ((capabilities.verified_joint_mask & mask) !== mask || modes.length !== bitCount(mask) || modes.includes("UNKNOWN")) return "未知 / 部分轴未读回";
  return new Set(modes).size === 1 ? `${modes[0]}（已读回）` : "混合模式（逐轴读回不一致）";
}

function bitCount(mask: number): number {
  let count = 0;
  for (let value = mask >>> 0; value; value >>>= 1) count += value & 1;
  return count;
}

export function controlGate(capabilities: MotorControlCapabilities | null, seenV2: boolean, drive: MotorDriveMode, mask: number): string | null {
  if (!capabilities?.supported) return drive === "MIT" && !seenV2 ? null : capabilities?.reason || "当前 Bridge / 固件未提供 POS_VEL 能力";
  if (!capabilities.fresh) return capabilities.reason || "驱动状态反馈过期，请等待新鲜读回";
  if (capabilities.switching) return "驱动模式切换中";
  if (capabilities.operation_state === 3 || capabilities.operation_state === 4) return "上次模式事务未成功，请停止后重新应用驱动模式";
  if (capabilities.fault_code !== 0) return `固件故障 ${capabilities.fault_code}，禁止开始控制`;
  if (drive === "MIT" && (capabilities.verified_joint_mask !== 0x7f || capabilities.control_modes.length !== 7
    || capabilities.control_modes.some(mode => mode !== "MIT") || capabilities.owner_source_id !== "0")) return "请恢复整组 7 轴 MIT 并释放 V2 占用";
  if (!mask) return "请至少选择一个关节";
  if ((capabilities.verified_joint_mask & mask) !== mask) return "所选轴尚未全部读回驱动模式";
  for (let index = 0; index < 32; index++) {
    if ((mask & (1 << index)) && capabilities.control_modes[index] !== drive) return `待应用：${drive}（实际驱动尚未全部确认）`;
  }
  if (drive === "POS_VEL" && (capabilities.pos_vel_supported_mask & mask) !== mask) return "部分所选轴尚未通过 POS_VEL 验证";
  if (drive === "MIT" && capabilities.lease_id !== 0) return "V2 控制租约尚未释放，请先应用 MIT 驱动模式";
  return null;
}

export function parsePosVelValues(rows: MotorRowInput[], velocityLimits: string[], capabilities: MotorControlCapabilities, mode: number): { values?: PosVelValues; error?: string } {
  if (mode !== 0 && mode !== 1) return { error: "POS_VEL 仅支持 TRACK / HOLD" };
  const mask = selectedMotorMask(rows);
  if (!mask) return { error: "请至少选择一个关节" };
  if (mask > 0x7f || rows.length !== POS_VEL_JOINT_COUNT) return { error: "POS_VEL 必须使用 7 轴布局" };
  if ((capabilities.pos_vel_supported_mask & mask) !== mask) return { error: "部分所选轴尚未通过 POS_VEL 验证" };
  const position = Array<number>(POS_VEL_JOINT_COUNT).fill(0);
  const velocityLimit = Array<number>(POS_VEL_JOINT_COUNT).fill(0);
  for (let index = 0; index < POS_VEL_JOINT_COUNT; index++) {
    if (!rows[index].enabled) continue;
    const rawVelocity = velocityLimits[index] ?? "";
    const velocity = Number(rawVelocity);
    if (!rawVelocity.trim() || !Number.isFinite(velocity) || !Number.isFinite(Math.fround(velocity)) || velocity <= 0 || Math.fround(velocity) <= 0) return { error: `joint${index + 1} 速度上限必须为有效的正数` };
    const maximum = capabilities.velocity_limit_max[index];
    if (!Number.isFinite(maximum) || maximum <= 0 || velocity > maximum) return { error: `joint${index + 1} 速度上限超过已验证范围（${maximum ?? "未知"} rad/s）` };
    velocityLimit[index] = velocity;
    // HOLD is latched by firmware; no stale form target is sent on that path.
    if (mode === 0) continue;
    const rawPosition = rows[index].position;
    const target = Number(rawPosition);
    if (!rawPosition.trim() || !Number.isFinite(target) || !Number.isFinite(Math.fround(target))) return { error: `joint${index + 1} Position 必须为有效数字` };
    const min = capabilities.position_min[index]; const max = capabilities.position_max[index];
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || target < min || target > max) return { error: `joint${index + 1} Position 超过已验证范围（${min ?? "未知"} 至 ${max ?? "未知"} rad）` };
    position[index] = target;
  }
  return { values: { position, velocityLimit, mask } };
}

export function createPosVelPayload(mode: 0 | 1, values: PosVelValues, capabilities: MotorControlCapabilities): BridgeEnvelope {
  return {
    op: "motor_command_v2", boot_id: capabilities.boot_id, control_epoch: capabilities.control_epoch,
    lease_id: capabilities.lease_id, control_mode: "POS_VEL", mode, active_joint_mask: values.mask,
    position: values.position, pos_vel: { velocity_limit: values.velocityLimit }, confirmation: "ARMED",
  };
}

export function hasStopProof(current: MotorControlCapabilities, previous: MotorControlCapabilities, sequence: number): boolean {
  const distance = (current.last_command_sequence - sequence) >>> 0;
  let advanced = false;
  try { advanced = BigInt(current.stamp_ns) > BigInt(previous.stamp_ns); } catch { return false; }
  return current.supported && current.fresh && current.boot_id === previous.boot_id
    && current.disabled_verified === true && advanced && distance < 0x80000000 && current.enabled_joint_mask === 0 && current.lease_id === 0 && current.mode === 3 && !current.switching;
}
