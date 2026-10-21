import { describe, expect, it } from "vitest";
import {
  buildActiveJointMask,
  createCommandPayload,
  createDefaultMotors,
  DEFAULT_JOINT_COUNT,
  DEFAULT_KD,
  DEFAULT_KP,
  DEFAULT_MODE,
  DEFAULT_TRAVEL,
  faultInfo,
  motorFaults,
  normalizeDecimal,
  parseCommandValues,
  parseTravelBound,
  resizeMotors,
} from "./motorLogic";

describe("motor command input", () => {
  it("defaults to TRACK with Kp 8 and Kd 2 and ±0.35 travel", () => {
    expect(DEFAULT_MODE).toBe(1);
    expect(DEFAULT_KP).toBe("8");
    expect(DEFAULT_KD).toBe("2");
    expect(DEFAULT_TRAVEL).toBe(0.35);
    expect(DEFAULT_JOINT_COUNT).toBe(7);
    expect(createDefaultMotors()[0]).toMatchObject({
      enabled: false, position: "0", min: "-0.35", max: "0.35",
    });
  });

  it("accepts decimal editing states and normalizes comma", () => {
    expect(normalizeDecimal("-0.")).toBe("-0.");
    expect(normalizeDecimal(".25")).toBe(".25");
    expect(normalizeDecimal("0,25")).toBe("0.25");
    expect(normalizeDecimal("1a")).toBeNull();
  });

  it("requires at least one enabled motor and limits effort", () => {
    const motors = createDefaultMotors(2);
    motors[0].enabled = true;
    motors[0].position = "12";
    expect(parseCommandValues({ velocity: "30", kp: "80", kd: "12", effort: "1" }, motors).values)
      .toEqual({
        positions: [12, 0],
        active_joint_mask: 0x01,
        velocity: 30,
        kp: 80,
        kd: 12,
        effort: 1,
      });
    expect(parseCommandValues({ velocity: "0", kp: "8", kd: "2", effort: "1.01" }, motors).error)
      .toContain("Effort");
    motors[0].enabled = false;
    expect(parseCommandValues({ velocity: "0", kp: "8", kd: "2", effort: "0" }, motors).error)
      .toContain("至少使能");
  });

  it("builds mask bits and zeros DISABLE payload", () => {
    expect(buildActiveJointMask([true, false, true])).toBe(0x05);
    const values = {
      positions: [0.2, 0, 0.1],
      active_joint_mask: 0x05,
      velocity: 0.1,
      kp: 8,
      kd: 2,
      effort: 0,
    };
    expect(createCommandPayload(1, values)).toMatchObject({
      mode: 1, confirmation: "ARMED", position: [0.2, 0, 0.1], active_joint_mask: 0x05, kp: 8,
    });
    expect(createCommandPayload(3)).toEqual({
      op: "joint_command",
      mode: 3,
      position: [],
      velocity: 0,
      kp: 0,
      kd: 0,
      effort: 0,
      active_joint_mask: 0,
      confirmation: "",
    });
  });

  it("resizes motor rows without wiping existing edits", () => {
    const motors = createDefaultMotors(2);
    motors[0].enabled = true;
    motors[0].position = "0.2";
    const grown = resizeMotors(motors, 4);
    expect(grown).toHaveLength(4);
    expect(grown[0]).toMatchObject({ enabled: true, position: "0.2" });
    expect(grown[3].enabled).toBe(false);
    expect(resizeMotors(grown, 1)).toHaveLength(1);
  });
});

describe("STM32 fault catalog", () => {
  it("documents every firmware fault 0 through 11", () => {
    expect(Object.keys(motorFaults).map(Number)).toEqual([...Array(12).keys()]);
    expect(faultInfo(3)).toMatchObject({ name: "COMMAND_LIMIT" });
    expect(faultInfo(11).description).toContain("需先安全回零/托住，再重启 STM32");
    expect(faultInfo(11).description).toContain("无软恢复");
    expect(faultInfo(99).name).toBe("UNKNOWN");
  });
});


describe("motor travel bounds and multi-joint enable", () => {
  it("parses travel bounds and rejects blanks", () => {
    expect(parseTravelBound("-0.5", "min")).toEqual({ value: -0.5 });
    expect(parseTravelBound("0.35", "max")).toEqual({ value: 0.35 });
    expect(parseTravelBound(" ", "min").error).toContain("有效数字");
    expect(parseTravelBound("abc", "max").error).toContain("有效数字");
  });

  it("builds a multi-joint mask and zeros disabled positions", () => {
    const motors = createDefaultMotors(7);
    motors[0].enabled = true;
    motors[0].position = "0.1";
    motors[3].enabled = true;
    motors[3].position = "0.4";
    motors[6].enabled = true;
    motors[6].position = "-0.2";
    const parsed = parseCommandValues({ velocity: "0", kp: "8", kd: "2", effort: "0" }, motors);
    expect(parsed.values?.active_joint_mask).toBe(0b1001001);
    expect(parsed.values?.positions).toEqual([0.1, 0, 0, 0.4, 0, 0, -0.2]);
    motors[3].position = "";
    expect(parseCommandValues({ velocity: "0", kp: "8", kd: "2", effort: "0" }, motors).error)
      .toContain("joint4 Position");
  });
});
