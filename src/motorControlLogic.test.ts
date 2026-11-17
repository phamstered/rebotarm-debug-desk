import { describe, expect, it } from "vitest";
import { createDefaultMotors } from "./motorLogic";
import { actualDriveMode, acceptMotorEvidence, controlGate, createPosVelPayload, hasStopProof, parsePosVelValues } from "./motorControlLogic";
import type { MotorControlCapabilities } from "./types";
const caps: MotorControlCapabilities = { supported: true, fresh: true, reason: "", age_ms: 0, protocol_version: 2, boot_id: "9007199254740993", control_epoch: 2, source_id: "5", owner_source_id: "5", lease_id: 9, selected_joint_mask: 1, enabled_joint_mask: 0, verified_joint_mask: 127, pos_vel_supported_mask: 63, control_modes: Array(7).fill("POS_VEL"), velocity_limit_max: Array(7).fill(2), position_min: Array(7).fill(-3), position_max: Array(7).fill(3), switching: false, disabled_verified: true, operation_id: 1, operation_state: 2, last_command_sequence: 40, mode: 3, fault_code: 0, error_code: 0, rejected_sequence: 0, reject_code: 0, stamp_ns: "1000000000" };
function inputs() { const rows = createDefaultMotors(); rows[0].enabled = true; rows[0].position = "0.2"; return { rows, velocities: ["0.4", ...Array(6).fill("")] }; }
describe("POS_VEL validation", () => {
  it.each(["", " ", "0", "-1", "NaN", "Infinity", "1e40", "1e-50"])("rejects invalid velocity %s", value => { const { rows, velocities } = inputs(); velocities[0] = value; expect(parsePosVelValues(rows, velocities, caps, 1).error).toContain("速度上限"); });
  it.each(["", "NaN", "Infinity", "1e40", "3.1"])("rejects invalid position %s", value => { const { rows, velocities } = inputs(); rows[0].position = value; expect(parsePosVelValues(rows, velocities, caps, 1).error).toContain("Position"); });
  it("checks per-axis capability, explicit mask, mode, and hardware velocity limit", () => {
    const { rows, velocities } = inputs(); expect(parsePosVelValues(rows, velocities, caps, 2).error).toContain("TRACK / HOLD");
    velocities[0] = "2.1"; expect(parsePosVelValues(rows, velocities, caps, 1).error).toContain("已验证范围"); velocities[0] = "0.4";
    rows[6].enabled = true; expect(parsePosVelValues(rows, velocities, caps, 1).error).toContain("部分所选轴"); rows[6].enabled = false; rows[0].enabled = false;
    expect(parsePosVelValues(rows, velocities, caps, 1).error).toContain("至少选择");
  });
  it("zeros unselected channels, strips MIT fields, and does not reuse a HOLD target", () => {
    const { rows, velocities } = inputs(); rows[2].position = "invalid"; velocities[2] = "invalid";
    const values = parsePosVelValues(rows, velocities, caps, 1).values!;
    expect(createPosVelPayload(1, values, caps)).toEqual({ op: "motor_command_v2", boot_id: caps.boot_id, control_epoch: 2, lease_id: 9, control_mode: "POS_VEL", mode: 1, active_joint_mask: 1, position: [0.2, 0, 0, 0, 0, 0, 0], pos_vel: { velocity_limit: [0.4, 0, 0, 0, 0, 0, 0] }, confirmation: "ARMED" });
    rows[0].position = ""; expect(parsePosVelValues(rows, velocities, caps, 0).values?.position).toEqual(Array(7).fill(0));
  });
});
describe("runtime mode evidence", () => {
  it("retains source watermarks and rejects epoch rollback and retired firmware boots", () => {
    const first = acceptMotorEvidence(null, caps).watermark;
    expect(acceptMotorEvidence(first, caps).advanced).toBe(false);
    expect(acceptMotorEvidence(first, { ...caps, fresh: false }).watermark).toBe(first);
    expect(acceptMotorEvidence(first, { ...caps, control_epoch: 1, stamp_ns: "2000000000" }).error).toBeTruthy();
    const second = acceptMotorEvidence(first, { ...caps, boot_id: "2", stamp_ns: "1" }).watermark;
    expect(second?.retiredBoots).toEqual([caps.boot_id]);
    expect(acceptMotorEvidence(second, { ...caps, stamp_ns: "3000000000" }).error).toBeTruthy();
  });
  it("requires complete fresh readback and cannot downgrade after V2 observation", () => {
    expect(controlGate(null, false, "MIT", 1)).toBeNull(); expect(controlGate(null, true, "MIT", 1)).toBeTruthy(); expect(controlGate(null, false, "POS_VEL", 1)).toBeTruthy();
    expect(controlGate(caps, true, "POS_VEL", 1)).toBeNull(); expect(controlGate({ ...caps, fresh: false }, true, "POS_VEL", 1)).toBeTruthy();
    expect(controlGate({ ...caps, verified_joint_mask: 0 }, true, "POS_VEL", 1)).toContain("未全部读回");
    expect(controlGate(caps, true, "MIT", 1)).toContain("恢复整组"); expect(actualDriveMode({ ...caps, verified_joint_mask: 0 }, 1)).toContain("未知");
    const mit = { ...caps, control_modes: Array(7).fill("MIT") as MotorControlCapabilities["control_modes"], owner_source_id: "0", lease_id: 0 };
    expect(controlGate(mit, true, "MIT", 1)).toBeNull();
    expect(controlGate({ ...mit, owner_source_id: "5" }, true, "MIT", 1)).toContain("恢复整组");
    expect(controlGate({ ...mit, control_modes: ["MIT", "MIT", "MIT", "MIT", "MIT", "MIT", "POS_VEL"] }, true, "MIT", 1)).toContain("恢复整组");
  });
  it("needs advancing source stamp, matching boot/epoch, DISABLE and an acknowledged sequence to prove output off", () => {
    const next = { ...caps, stamp_ns: "2000000000", last_command_sequence: 42, lease_id: 0 };
    expect(hasStopProof(next, caps, 42)).toBe(true);
    for (const patch of [{ stamp_ns: caps.stamp_ns }, { boot_id: "2" }, { disabled_verified: false }, { lease_id: 9 }, { mode: 0 }, { enabled_joint_mask: 1 }, { fresh: false }, { last_command_sequence: 41 }, { switching: true }]) expect(hasStopProof({ ...next, ...patch }, caps, 42)).toBe(false);
    expect(hasStopProof({ ...next, control_epoch: 3 }, caps, 42)).toBe(true); // Canceling configuration advances its epoch.
    expect(hasStopProof({ ...next, last_command_sequence: 1 }, caps, 0xffffffff)).toBe(true);
  });
});
