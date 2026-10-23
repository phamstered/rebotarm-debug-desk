/** @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";
import {
  MODE_FULL_ARM_GRAVITY,
  MODE_PAYLOAD_SUBMODE,
  DEFAULT_JOINT_MASK,
  PHASE_ARMING,
  PHASE_CAPTURING,
  PHASE_DONE,
  PHASE_FAILED,
  PHASE_IDLE,
  PHASE_WRITING,
  buildGravityIdCancelPayload,
  buildGravityIdSendGoalPayload,
  canAbortGravityId,
  canSendGravityIdGoal,
  defaultGravityIdGoalForm,
  effectiveJointMask,
  faultCodeLabel,
  isSessionRunningPhase,
  jointBitsFromMask,
  jointMaskFromBits,
  parseGravityIdFeedback,
  parseGravityIdResult,
  phaseLabel,
  sessionStateFromPhase,
} from "./gravityIdentificationLogic";

describe("gravityIdentificationLogic mask / phase", () => {
  it("maps joint bits to mask and back", () => {
    expect(jointMaskFromBits([true, true, true, true, true, true])).toBe(DEFAULT_JOINT_MASK);
    expect(jointMaskFromBits([true, false, true, false, false, false])).toBe(0b000101);
    expect(jointBitsFromMask(0x3f)).toEqual([true, true, true, true, true, true]);
    expect(jointBitsFromMask(0b101)).toEqual([true, false, true, false, false, false]);
  });

  it("treats joint_mask 0 as DEFAULT_JOINT_MASK", () => {
    expect(effectiveJointMask(0)).toBe(DEFAULT_JOINT_MASK);
    expect(effectiveJointMask(0x15)).toBe(0x15);
    expect(effectiveJointMask(0xff)).toBe(DEFAULT_JOINT_MASK);
  });

  it("labels phases and detects running / terminal", () => {
    expect(phaseLabel(PHASE_CAPTURING)).toBe("CAPTURING");
    expect(phaseLabel(99)).toBe("PHASE_99");
    expect(isSessionRunningPhase(PHASE_ARMING)).toBe(true);
    expect(isSessionRunningPhase(PHASE_WRITING)).toBe(true);
    expect(isSessionRunningPhase(PHASE_IDLE)).toBe(false);
    expect(isSessionRunningPhase(PHASE_DONE)).toBe(false);
    expect(isSessionRunningPhase(PHASE_FAILED)).toBe(false);
  });

  it("derives session state from phase and cancel", () => {
    expect(sessionStateFromPhase(null)).toBe("idle");
    expect(sessionStateFromPhase(PHASE_IDLE)).toBe("idle");
    expect(sessionStateFromPhase(PHASE_CAPTURING)).toBe("running");
    expect(sessionStateFromPhase(PHASE_CAPTURING, true)).toBe("canceling");
    expect(sessionStateFromPhase(PHASE_DONE)).toBe("idle");
  });
});

describe("gravityIdentificationLogic ARMED gate", () => {
  it("requires ARMED when idle and blocks while running", () => {
    expect(canSendGravityIdGoal("ARMED", "idle")).toBe(true);
    expect(canSendGravityIdGoal("", "idle")).toBe(false);
    expect(canSendGravityIdGoal("ARMED", "running")).toBe(false);
    expect(canSendGravityIdGoal("ARMED", "canceling")).toBe(false);
    expect(canAbortGravityId("idle")).toBe(false);
    expect(canAbortGravityId("running")).toBe(true);
    expect(canAbortGravityId("canceling")).toBe(true);
  });

  it("builds send_goal only with ARMED confirmation", () => {
    const form = defaultGravityIdGoalForm();
    const blocked = buildGravityIdSendGoalPayload(form, "", "r1");
    expect(blocked).toEqual({ ok: false, error: "须先完成安全确认（confirmation: ARMED）" });

    const ok = buildGravityIdSendGoalPayload(form, "ARMED", "r2");
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.payload).toMatchObject({
      op: "gravity_id_send_goal",
      request_id: "r2",
      confirmation: "ARMED",
      joint_mask: DEFAULT_JOINT_MASK,
      mode: MODE_FULL_ARM_GRAVITY,
      settle_time_s: 1.5,
      write_yaml: true,
      lock_gripper: true,
    });
    expect(buildGravityIdCancelPayload("c1")).toEqual({ op: "gravity_id_cancel", request_id: "c1" });
  });

  it("rejects invalid mode / non-finite goal fields", () => {
    const form = defaultGravityIdGoalForm();
    expect(buildGravityIdSendGoalPayload({ ...form, mode: 9 }, "ARMED", "x")).toEqual({
      ok: false,
      error: "mode 仅支持 FULL_ARM_GRAVITY(0) 或 PAYLOAD_SUBMODE(1)",
    });
    expect(buildGravityIdSendGoalPayload({ ...form, settleTimeS: Number.NaN }, "ARMED", "x")).toEqual({
      ok: false,
      error: "Goal 数值必须为有限值",
    });
    expect(buildGravityIdSendGoalPayload({ ...form, maxEffortNm: -1 }, "ARMED", "x")).toEqual({
      ok: false,
      error: "Goal 数值不得为负",
    });
    expect(MODE_PAYLOAD_SUBMODE).toBe(1);
  });
});

describe("gravityIdentificationLogic parse feedback / result", () => {
  it("parses feedback and result payloads", () => {
    const feedback = parseGravityIdFeedback({
      phase: 5,
      pose_index: 3,
      pose_count: 12,
      active_joint_mask: 63,
      residual_nm: [0.1, 0.2],
      measured_effort_nm: [1, 2],
      model_effort_nm: [0.9, 1.8],
      rmse_running: 0.12,
      fault_code: 0,
      message: "capturing",
    }, 1000);
    expect(feedback).toMatchObject({
      phase: 5,
      poseIndex: 3,
      poseCount: 12,
      rmseRunning: 0.12,
      message: "capturing",
      receivedAt: 1000,
    });

    expect(parseGravityIdFeedback({ phase: "x" })).toBeNull();
    expect(parseGravityIdFeedback({ phase: 1, residual_nm: [Number.NaN] })).toBeNull();

    const result = parseGravityIdResult({
      success: true,
      fault_code: 0,
      gravity_scales: [1, 1, 1, 1, 1, 1],
      torque_biases_nm: [0, 0, 0, 0, 0, 0],
      rmse_per_joint: [0.01, 0.02, 0.01, 0.03, 0.01, 0.01],
      rmse_total: 0.04,
      yaml_path: "/tmp/g.yaml",
      message: "ok",
    });
    expect(result).toMatchObject({
      success: true,
      yamlPath: "/tmp/g.yaml",
      rmseTotal: 0.04,
    });
    expect(parseGravityIdResult(null)).toBeNull();
    expect(faultCodeLabel(11)).toContain("命令丢失");
  });
});
