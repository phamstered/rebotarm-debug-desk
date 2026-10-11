export const JOINT4_CALIBRATION_STATUS_TOPIC = "/joint4_calibration_controller/status";

export const JOINT4_CALIBRATION_LIMITS = {
  maxCorrectionEffort: 1.5,
  maxPositionError: 0.12,
  maxCalibrationVelocity: 0.2,
  maxBeginVelocity: 0.05,
  captureVelocityThreshold: 0.01,
  stableDuration: 1.5,
  statusTimeoutMs: 1500,
  minimumPoses: 4,
  recommendedPoses: 6,
} as const;

export type Joint4CalibrationStatus = {
  q4: number;
  dq4: number;
  modelEffort: number;
  correctionEffort: number;
  requiredEffort: number;
  payloadSensitivity: number;
  poseReference: number;
  stableSeconds: number;
  sampleCount: number;
  poseActive: boolean;
  safetyFault: boolean;
  poseCaptured: boolean;
  receivedAt: number;
};

export type Joint4CalibrationSample = {
  pose: number;
  q4: number;
  modelEffort: number;
  requiredEffort: number;
  payloadSensitivity: number;
  capturedAt: string;
};

export type Joint4FitResult = {
  samples?: number;
  gravityScale?: number;
  constantBias?: number;
  gravityRmse?: number;
  equivalentPayloadMass?: number;
  payloadBias?: number;
  payloadRmse?: number;
  raw: string;
};

export type CalibrationAvailability = {
  statusFresh: boolean;
  beginAllowed: boolean;
  captureAllowed: boolean;
  blockers: string[];
  recoverySteps: string[];
};

function finiteNumbers(value: unknown): number[] | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length < 12) return null;
  const numbers = data.slice(0, 12).map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

export function parseJoint4CalibrationStatus(
  value: unknown,
  receivedAt = Date.now(),
): Joint4CalibrationStatus | null {
  const data = finiteNumbers(value);
  if (!data) return null;
  return {
    q4: data[0],
    dq4: data[1],
    modelEffort: data[2],
    correctionEffort: data[3],
    requiredEffort: data[4],
    payloadSensitivity: data[5],
    poseReference: data[6],
    stableSeconds: Math.max(0, data[7]),
    sampleCount: Math.max(0, Math.trunc(data[8])),
    poseActive: data[9] !== 0,
    safetyFault: data[10] !== 0,
    poseCaptured: data[11] !== 0,
    receivedAt,
  };
}

export function calibrationAvailability(
  status: Joint4CalibrationStatus | null,
  controllerActive: boolean,
  now = Date.now(),
): CalibrationAvailability {
  const blockers: string[] = [];
  const recoverySteps: string[] = [];
  const statusFresh = Boolean(
    status && now - status.receivedAt >= 0
    && now - status.receivedAt <= JOINT4_CALIBRATION_LIMITS.statusTimeoutMs,
  );

  if (!controllerActive) {
    blockers.push("joint4_calibration_controller 未处于 active 状态");
    recoverySteps.push("托住机械臂，在 ROS Control 面板确认普通重力控制器已停用，再激活标定控制器。 ");
  }
  if (!status) {
    blockers.push("尚未收到标定状态");
    recoverySteps.push("检查状态 Topic 与 Bridge 订阅，确认控制器正在发布 10 Hz 状态。 ");
  } else if (!statusFresh) {
    blockers.push("标定状态已超时");
    recoverySteps.push("继续托住机械臂，检查 Jetson、controller_manager 和网络连接，状态恢复前不要采样。 ");
  }
  if (status?.safetyFault) {
    blockers.push("控制器已触发 safety_fault");
    recoverySteps.push("托住 joint4 并执行安全停止（release_pose）清除故障；若旧版 Controller 仍保持 fault，可在姿态已释放且速度安全时重新 Begin Pose。 ");
  }
  if (status?.poseActive) {
    const displacement = Math.abs(status.q4 - status.poseReference);
    if (displacement >= JOINT4_CALIBRATION_LIMITS.maxPositionError) {
      blockers.push(`参考位移达到保护阈值 ${JOINT4_CALIBRATION_LIMITS.maxPositionError.toFixed(2)} rad`);
    }
    if (Math.abs(status.dq4) >= JOINT4_CALIBRATION_LIMITS.maxCalibrationVelocity) {
      blockers.push(`joint4 速度达到保护阈值 ${JOINT4_CALIBRATION_LIMITS.maxCalibrationVelocity.toFixed(2)} rad/s`);
    }
    if (Math.abs(status.correctionEffort) >= JOINT4_CALIBRATION_LIMITS.maxCorrectionEffort) {
      blockers.push(`软保持修正力矩达到 ±${JOINT4_CALIBRATION_LIMITS.maxCorrectionEffort.toFixed(1)} N·m`);
    }
  }

  if (blockers.some((reason) => reason.includes("保护阈值") || reason.includes("修正力矩"))) {
    recoverySteps.push("立即托住机械臂并执行安全停止；减小姿态跨度或外力后再开始新姿态。 ");
  }

  const connectedAndFresh = controllerActive && statusFresh && Boolean(status);
  const healthy = connectedAndFresh && !status!.safetyFault
    && !blockers.some((reason) => reason.includes("保护阈值") || reason.includes("修正力矩"));
  const beginAllowed = Boolean(
    connectedAndFresh && !status!.poseActive
    && Math.abs(status!.dq4) <= JOINT4_CALIBRATION_LIMITS.maxBeginVelocity,
  );
  const captureAllowed = Boolean(
    healthy && status!.poseActive && !status!.poseCaptured
    && status!.stableSeconds >= JOINT4_CALIBRATION_LIMITS.stableDuration
    && Math.abs(status!.dq4) <= JOINT4_CALIBRATION_LIMITS.captureVelocityThreshold,
  );

  if (statusFresh && status && !status.poseActive && Math.abs(status.dq4) > JOINT4_CALIBRATION_LIMITS.maxBeginVelocity) {
    blockers.push(`begin_pose 要求速度不超过 ${JOINT4_CALIBRATION_LIMITS.maxBeginVelocity.toFixed(2)} rad/s`);
  }
  if (statusFresh && status?.poseActive && !captureAllowed && !status.safetyFault) {
    if (status.poseCaptured) blockers.push("当前姿态已经采样，请先托住并释放后移动到下一姿态");
    else if (Math.abs(status.dq4) > JOINT4_CALIBRATION_LIMITS.captureVelocityThreshold) {
      blockers.push(`采样要求速度不超过 ${JOINT4_CALIBRATION_LIMITS.captureVelocityThreshold.toFixed(2)} rad/s`);
    } else {
      blockers.push(`仍需稳定 ${(JOINT4_CALIBRATION_LIMITS.stableDuration - status.stableSeconds).toFixed(1)} s`);
    }
  }

  return { statusFresh, beginAllowed, captureAllowed, blockers, recoverySteps: [...new Set(recoverySteps)] };
}

function numberField(message: string, name: string): number | undefined {
  const match = message.match(new RegExp(`${name}=([-+]?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export function sampleFromCaptureMessage(
  message: string,
  pose: number,
  fallback: Joint4CalibrationStatus,
  capturedAt = new Date().toISOString(),
): Joint4CalibrationSample {
  return {
    pose,
    q4: numberField(message, "q4") ?? fallback.q4,
    modelEffort: numberField(message, "model") ?? fallback.modelEffort,
    requiredEffort: numberField(message, "required") ?? fallback.requiredEffort,
    payloadSensitivity: numberField(message, "payload_sensitivity") ?? fallback.payloadSensitivity,
    capturedAt,
  };
}

export function parseFitResult(message: string): Joint4FitResult {
  return {
    samples: numberField(message, "samples"),
    gravityScale: numberField(message, "gravity_scale"),
    constantBias: numberField(message, "constant_bias"),
    gravityRmse: numberField(message, "gravity_rmse"),
    equivalentPayloadMass: numberField(message, "equivalent_payload_mass"),
    payloadBias: numberField(message, "payload_bias"),
    payloadRmse: numberField(message, "payload_rmse"),
    raw: message,
  };
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildCalibrationReport(
  samples: Joint4CalibrationSample[],
  fit: Joint4FitResult | null,
  format: "json" | "csv",
) {
  if (format === "json") {
    return JSON.stringify({
      schema: "robot-console/joint4-calibration/v1",
      exportedAt: new Date().toISOString(),
      limits: JOINT4_CALIBRATION_LIMITS,
      samples,
      fit,
      advisoryOnly: true,
    }, null, 2);
  }
  const rows = [
    ["pose", "q4_rad", "model_effort_nm", "required_effort_nm", "payload_sensitivity_nm_per_kg", "captured_at"],
    ...samples.map((sample) => [
      sample.pose,
      sample.q4,
      sample.modelEffort,
      sample.requiredEffort,
      sample.payloadSensitivity,
      sample.capturedAt,
    ]),
  ];
  const fitRows = fit ? Object.entries(fit)
    .filter(([key, value]) => key !== "raw" && value !== undefined)
    .map(([key, value]) => ["fit", key, value as number, "", "", ""]) : [];
  return [...rows, ...fitRows].map((row) => row.map(csvCell).join(",")).join("\n");
}
