/** Gravity Identification UI logic — aligned to stack PR #23 /StartGravityID freeze. */

export const GRAVITY_ID_ACTION = "/StartGravityID";
export const GRAVITY_ID_ACTION_TYPE = "microros_stm32h723_bridge/action/GravityIdentification";

export const MODE_FULL_ARM_GRAVITY = 0;
export const MODE_PAYLOAD_SUBMODE = 1;
export const DEFAULT_JOINT_MASK = 0x3f;

/** Feedback.phase — stack docs §4.1 / action IDL */
export const PHASE_IDLE = 0;
export const PHASE_ARMING = 1;
export const PHASE_ARMED = 2;
export const PHASE_MOVING = 3;
export const PHASE_HOLD_SETTLE = 4;
export const PHASE_CAPTURING = 5;
export const PHASE_FITTING = 6;
export const PHASE_WRITING = 7;
export const PHASE_ABORTING = 8;
export const PHASE_DONE = 9;
export const PHASE_FAILED = 10;

export const PHASE_LABELS: Record<number, string> = {
  [PHASE_IDLE]: "IDLE",
  [PHASE_ARMING]: "ARMING",
  [PHASE_ARMED]: "ARMED",
  [PHASE_MOVING]: "MOVING",
  [PHASE_HOLD_SETTLE]: "HOLD_SETTLE",
  [PHASE_CAPTURING]: "CAPTURING",
  [PHASE_FITTING]: "FITTING",
  [PHASE_WRITING]: "WRITING",
  [PHASE_ABORTING]: "ABORTING",
  [PHASE_DONE]: "DONE",
  [PHASE_FAILED]: "FAILED",
};

export const JOINT_BIT_LABELS = ["J1", "J2", "J3", "J4", "J5", "J6"] as const;

export const GRAVITY_ID_DEFAULTS = {
  jointMask: DEFAULT_JOINT_MASK,
  mode: MODE_FULL_ARM_GRAVITY,
  settleTimeS: 1.5,
  captureWindowS: 1.0,
  writeYaml: true,
  hotReload: true,
  outputYamlPath: "",
  maxEffortNm: 1.0,
  maxVelocityRadS: 0.15,
  commandTimeoutMs: 100,
  lockGripper: true,
} as const;

/** Firmware / host notes to surface in UI (no firmware changes). */
export const FIRMWARE_SAFETY_NOTES = [
  "会话中必须持续发送 JointCommand；约 100 ms 无命令进入 HOLD，约 500 ms 锁存 fault 11。",
  "HOLD 会清零 MIT effort；需要重力前馈采样时用 TRACK、velocity≈0、effort=前馈。",
  "|effort|≤10 Nm。J1–J3 为 DM4340P、J4–J6 为 DM4310，勿假设同一激励适合全部关节。",
] as const;

export type GravityIdGoalForm = {
  jointMask: number;
  mode: number;
  poseSetId: string[];
  settleTimeS: number;
  captureWindowS: number;
  writeYaml: boolean;
  hotReload: boolean;
  outputYamlPath: string;
  maxEffortNm: number;
  maxVelocityRadS: number;
  commandTimeoutMs: number;
  lockGripper: boolean;
};

export type GravityIdFeedback = {
  phase: number;
  poseIndex: number;
  poseCount: number;
  activeJointMask: number;
  residualNm: number[];
  measuredEffortNm: number[];
  modelEffortNm: number[];
  rmseRunning: number;
  faultCode: number;
  message: string;
  receivedAt: number;
};

export type GravityIdResult = {
  success: boolean;
  faultCode: number;
  gravityScales: number[];
  torqueBiasesNm: number[];
  rmsePerJoint: number[];
  rmseTotal: number;
  yamlPath: string;
  message: string;
};

export type GravityIdSessionState = "idle" | "running" | "canceling";

export type GravityIdGoalRequest = GravityIdGoalForm & {
  confirmation: string;
};

function finiteNumberArray(value: unknown, maxLen = 16): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > maxLen) return null;
  const numbers = value.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

export function jointMaskFromBits(enabled: boolean[]): number {
  let mask = 0;
  for (let index = 0; index < Math.min(6, enabled.length); index += 1) {
    if (enabled[index]) mask |= 1 << index;
  }
  return mask;
}

export function jointBitsFromMask(mask: number): boolean[] {
  return JOINT_BIT_LABELS.map((_, index) => ((mask >> index) & 1) === 1);
}

/** joint_mask==0 → DEFAULT_JOINT_MASK (0x3F) per stack contract. */
export function effectiveJointMask(mask: number): number {
  const truncated = mask >>> 0;
  return truncated === 0 ? DEFAULT_JOINT_MASK : truncated & DEFAULT_JOINT_MASK;
}

export function phaseLabel(phase: number): string {
  return PHASE_LABELS[phase] ?? `PHASE_${phase}`;
}

/** ARMING…WRITING and ABORTING lock Motor / TCP / Joint4 capture. */
export function isSessionRunningPhase(phase: number): boolean {
  return phase >= PHASE_ARMING && phase <= PHASE_ABORTING;
}

export function isTerminalPhase(phase: number): boolean {
  return phase === PHASE_DONE || phase === PHASE_FAILED || phase === PHASE_IDLE;
}

export function sessionStateFromPhase(
  phase: number | null | undefined,
  cancelRequested = false,
): GravityIdSessionState {
  if (cancelRequested) return "canceling";
  if (phase === null || phase === undefined) return "idle";
  if (isSessionRunningPhase(phase)) return "running";
  return "idle";
}

export function canSendGravityIdGoal(confirmation: string, session: GravityIdSessionState): boolean {
  if (session === "running" || session === "canceling") return false;
  return confirmation === "ARMED";
}

export function canAbortGravityId(session: GravityIdSessionState): boolean {
  return session === "running" || session === "canceling";
}

export function buildGravityIdSendGoalPayload(
  form: GravityIdGoalForm,
  confirmation: string,
  requestId: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  if (confirmation !== "ARMED") {
    return { ok: false, error: "须先完成安全确认（confirmation: ARMED）" };
  }
  const settle = Number(form.settleTimeS);
  const capture = Number(form.captureWindowS);
  const maxEffort = Number(form.maxEffortNm);
  const maxVelocity = Number(form.maxVelocityRadS);
  const timeout = Number(form.commandTimeoutMs);
  if (![settle, capture, maxEffort, maxVelocity, timeout].every(Number.isFinite)) {
    return { ok: false, error: "Goal 数值必须为有限值" };
  }
  if (settle < 0 || capture < 0 || maxEffort < 0 || maxVelocity < 0 || timeout < 0) {
    return { ok: false, error: "Goal 数值不得为负" };
  }
  const mode = Number(form.mode);
  if (mode !== MODE_FULL_ARM_GRAVITY && mode !== MODE_PAYLOAD_SUBMODE) {
    return { ok: false, error: "mode 仅支持 FULL_ARM_GRAVITY(0) 或 PAYLOAD_SUBMODE(1)" };
  }
  return { ok: true, payload: {
    op: "gravity_id_send_goal",
    request_id: requestId,
    confirmation: "ARMED",
    joint_mask: effectiveJointMask(Number(form.jointMask) || 0),
    mode,
    pose_set_id: Array.isArray(form.poseSetId) ? form.poseSetId.map(String) : [],
    settle_time_s: settle,
    capture_window_s: capture,
    write_yaml: Boolean(form.writeYaml),
    hot_reload: Boolean(form.hotReload),
    output_yaml_path: String(form.outputYamlPath ?? ""),
    max_effort_nm: maxEffort,
    max_velocity_rad_s: maxVelocity,
    command_timeout_ms: timeout,
    lock_gripper: Boolean(form.lockGripper),
  } };
}

export function buildGravityIdCancelPayload(requestId: string): Record<string, unknown> {
  return { op: "gravity_id_cancel", request_id: requestId };
}

export function parseGravityIdFeedback(
  value: unknown,
  receivedAt = Date.now(),
): GravityIdFeedback | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const phase = Number(raw.phase);
  const poseIndex = Number(raw.pose_index ?? raw.poseIndex ?? 0);
  const poseCount = Number(raw.pose_count ?? raw.poseCount ?? 0);
  const activeJointMask = Number(raw.active_joint_mask ?? raw.activeJointMask ?? 0);
  const rmseRunning = Number(raw.rmse_running ?? raw.rmseRunning ?? 0);
  const faultCode = Number(raw.fault_code ?? raw.faultCode ?? 0);
  if (![phase, poseIndex, poseCount, activeJointMask, rmseRunning, faultCode].every(Number.isFinite)) {
    return null;
  }
  const residualNm = finiteNumberArray(raw.residual_nm ?? raw.residualNm);
  const measuredEffortNm = finiteNumberArray(raw.measured_effort_nm ?? raw.measuredEffortNm);
  const modelEffortNm = finiteNumberArray(raw.model_effort_nm ?? raw.modelEffortNm);
  if (!residualNm || !measuredEffortNm || !modelEffortNm) return null;
  return {
    phase: Math.trunc(phase),
    poseIndex: Math.max(0, Math.trunc(poseIndex)),
    poseCount: Math.max(0, Math.trunc(poseCount)),
    activeJointMask: activeJointMask >>> 0,
    residualNm,
    measuredEffortNm,
    modelEffortNm,
    rmseRunning,
    faultCode: Math.max(0, Math.trunc(faultCode)),
    message: String(raw.message ?? ""),
    receivedAt,
  };
}

export function parseGravityIdResult(value: unknown): GravityIdResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const faultCode = Number(raw.fault_code ?? raw.faultCode ?? 0);
  const rmseTotal = Number(raw.rmse_total ?? raw.rmseTotal ?? 0);
  if (![faultCode, rmseTotal].every(Number.isFinite)) return null;
  const gravityScales = finiteNumberArray(raw.gravity_scales ?? raw.gravityScales);
  const torqueBiasesNm = finiteNumberArray(raw.torque_biases_nm ?? raw.torqueBiasesNm);
  const rmsePerJoint = finiteNumberArray(raw.rmse_per_joint ?? raw.rmsePerJoint);
  if (!gravityScales || !torqueBiasesNm || !rmsePerJoint) return null;
  const successRaw = raw.success;
  const success = successRaw === true || successRaw === 1 || successRaw === "true";
  return {
    success,
    faultCode: Math.max(0, Math.trunc(faultCode)),
    gravityScales,
    torqueBiasesNm,
    rmsePerJoint,
    rmseTotal,
    yamlPath: String(raw.yaml_path ?? raw.yamlPath ?? ""),
    message: String(raw.message ?? ""),
  };
}

export function defaultGravityIdGoalForm(): GravityIdGoalForm {
  return {
    jointMask: GRAVITY_ID_DEFAULTS.jointMask,
    mode: GRAVITY_ID_DEFAULTS.mode,
    poseSetId: [],
    settleTimeS: GRAVITY_ID_DEFAULTS.settleTimeS,
    captureWindowS: GRAVITY_ID_DEFAULTS.captureWindowS,
    writeYaml: GRAVITY_ID_DEFAULTS.writeYaml,
    hotReload: GRAVITY_ID_DEFAULTS.hotReload,
    outputYamlPath: GRAVITY_ID_DEFAULTS.outputYamlPath,
    maxEffortNm: GRAVITY_ID_DEFAULTS.maxEffortNm,
    maxVelocityRadS: GRAVITY_ID_DEFAULTS.maxVelocityRadS,
    commandTimeoutMs: GRAVITY_ID_DEFAULTS.commandTimeoutMs,
    lockGripper: GRAVITY_ID_DEFAULTS.lockGripper,
  };
}

export function faultCodeLabel(code: number): string {
  switch (code) {
    case 0:
      return "无故障";
    case 3:
      return "命令限幅 (3)";
    case 4:
      return "序列过期 (4)";
    case 7:
      return "电机驱动故障 (7)";
    case 11:
      return "命令丢失锁存 (11) → HOLD";
    default:
      return `fault ${code}`;
  }
}
