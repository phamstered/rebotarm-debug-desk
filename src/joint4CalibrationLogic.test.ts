import { describe, expect, it } from "vitest";
import {
  buildCalibrationReport,
  calibrationAvailability,
  parseFitResult,
  parseJoint4CalibrationStatus,
  sampleFromCaptureMessage,
} from "./joint4CalibrationLogic";

const rawStatus = { data: [0.4, 0.005, 1.2, 0.2, 1.4, 0.3, 0.39, 1.7, 3, 1, 0, 0] };

describe("joint4 calibration model", () => {
  it("parses the 12-value status contract and rejects malformed arrays", () => {
    expect(parseJoint4CalibrationStatus({ data: [1, 2] })).toBeNull();
    expect(parseJoint4CalibrationStatus({ data: [...rawStatus.data.slice(0, 11), Number.NaN] })).toBeNull();
    expect(parseJoint4CalibrationStatus(rawStatus, 1000)).toEqual({
      q4: 0.4, dq4: 0.005, modelEffort: 1.2, correctionEffort: 0.2,
      requiredEffort: 1.4, payloadSensitivity: 0.3, poseReference: 0.39,
      stableSeconds: 1.7, sampleCount: 3, poseActive: true, safetyFault: false,
      poseCaptured: false, receivedAt: 1000,
    });
  });

  it("only permits capture for a fresh, active, stable and healthy pose", () => {
    const status = parseJoint4CalibrationStatus(rawStatus, 1000)!;
    expect(calibrationAvailability(status, true, 1100).captureAllowed).toBe(true);
    expect(calibrationAvailability(status, true, 3000)).toMatchObject({
      statusFresh: false,
      captureAllowed: false,
    });
    const fault = { ...status, safetyFault: true };
    expect(calibrationAvailability(fault, true, 1100).blockers).toContain("控制器已触发 safety_fault");
    const saturated = { ...status, correctionEffort: 1.5 };
    expect(calibrationAvailability(saturated, true, 1100).captureAllowed).toBe(false);
  });

  it("requires a slow released pose before begin", () => {
    const status = parseJoint4CalibrationStatus({ ...rawStatus, data: rawStatus.data.map((value, index) => index === 9 ? 0 : value) }, 1000)!;
    expect(calibrationAvailability(status, true, 1100).beginAllowed).toBe(true);
    expect(calibrationAvailability({ ...status, dq4: 0.051 }, true, 1100).beginAllowed).toBe(false);
    expect(calibrationAvailability(status, false, 1100).beginAllowed).toBe(false);
    expect(calibrationAvailability({ ...status, safetyFault: true }, true, 1100)).toMatchObject({
      beginAllowed: true,
      captureAllowed: false,
    });
  });

  it("parses captured samples and both fit result families", () => {
    const status = parseJoint4CalibrationStatus(rawStatus)!;
    const sample = sampleFromCaptureMessage(
      "captured sample 4: q4=0.41200, model=1.23000 Nm, required=1.48000 Nm, payload_sensitivity=0.31000 Nm/kg",
      4,
      status,
      "2026-10-11T00:00:00.000Z",
    );
    expect(sample).toMatchObject({ pose: 4, q4: 0.412, modelEffort: 1.23, requiredEffort: 1.48, payloadSensitivity: 0.31 });
    expect(parseFitResult("samples=6; gravity_scale=1.120000; constant_bias=-0.020000 Nm; gravity_rmse=0.030000 Nm; equivalent_payload_mass=0.081000 kg; payload_bias=0.010000 Nm; payload_rmse=0.040000 Nm")).toMatchObject({
      samples: 6, gravityScale: 1.12, constantBias: -0.02, gravityRmse: 0.03,
      equivalentPayloadMass: 0.081, payloadBias: 0.01, payloadRmse: 0.04,
    });
  });

  it("exports auditable JSON and CSV without applying parameters", () => {
    const status = parseJoint4CalibrationStatus(rawStatus)!;
    const sample = sampleFromCaptureMessage("captured sample 1", 1, status, "now");
    expect(buildCalibrationReport([sample], null, "json")).toContain('"advisoryOnly": true');
    const csv = buildCalibrationReport([sample], parseFitResult("samples=4; gravity_scale=1.1"), "csv");
    expect(csv).toContain("pose,q4_rad,model_effort_nm");
    expect(csv).toContain("fit,gravityScale,1.1");
  });
});
