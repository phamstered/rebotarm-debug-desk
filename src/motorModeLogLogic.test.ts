import { describe, expect, it } from "vitest";
import { appendMotorModeLog, motorAxisNames, motorModeError, MOTOR_MODE_LOG_LIMIT, type MotorModeLogEntry } from "./motorModeLogLogic";

describe("bounded motor diagnostics", () => {
  it("keeps the newest 100 records and bounds untrusted error text", () => {
    let log: MotorModeLogEntry[] = [];
    for (let i = 0; i < 120; i++) log = appendMotorModeLog(log, `event ${i}`, "2026-11-20T01:02:03.004Z");
    expect(log).toHaveLength(MOTOR_MODE_LOG_LIMIT);
    expect(log[0].message).toBe("event 20"); expect(log.at(-1)?.message).toBe("event 119");
    expect(appendMotorModeLog(log, "x".repeat(5000)).at(-1)?.message).toHaveLength(4000);
  });
  it("preserves unknown error codes and distinguishes physical slots from URDF labels", () => {
    expect(motorModeError(999)).toBe("999（未知错误，请保留原始码）");
    expect(motorModeError(3)).toContain("尚未确认关闭输出");
    expect(motorAxisNames(64, ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "gripper_finger_left_joint"])).toBe("joint7（gripper_finger_left_joint）");
    expect(motorAxisNames(127).split("、")).toHaveLength(7);
  });
});
