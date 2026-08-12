import { describe, expect, it } from "vitest";
import { createCommandPayload, DEFAULT_KD, DEFAULT_KP, DEFAULT_MODE, faultInfo, motorFaults, normalizeDecimal, parseCommandValues } from "./motorLogic";

describe("motor command input", () => {
  it("defaults to TRACK with Kp 8 and Kd 2", () => {
    expect(DEFAULT_MODE).toBe(1);
    expect(DEFAULT_KP).toBe("8");
    expect(DEFAULT_KD).toBe("2");
  });

  it("accepts decimal editing states and normalizes comma", () => {
    expect(normalizeDecimal("-0.")).toBe("-0.");
    expect(normalizeDecimal(".25")).toBe(".25");
    expect(normalizeDecimal("0,25")).toBe("0.25");
    expect(normalizeDecimal("1a")).toBeNull();
  });

  it("does not limit position, velocity, Kp or Kd but limits effort", () => {
    expect(parseCommandValues({ position: "12", velocity: "30", kp: "80", kd: "12", effort: "1" }).values)
      .toEqual({ position: 12, velocity: 30, kp: 80, kd: 12, effort: 1 });
    expect(parseCommandValues({ position: "0", velocity: "0", kp: "8", kd: "2", effort: "1.01" }).error)
      .toContain("Effort");
    expect(parseCommandValues({ position: "", velocity: "0", kp: "8", kd: "2", effort: "0" }).error)
      .toContain("Position");
  });

  it("adds ARMED only to enabled commands and zeros DISABLE", () => {
    const values = { position: .2, velocity: .1, kp: 8, kd: 2, effort: 0 };
    expect(createCommandPayload(1, values)).toMatchObject({ mode: 1, confirmation: "ARMED", ...values });
    expect(createCommandPayload(3)).toEqual({
      op: "joint_command", mode: 3, position: 0, velocity: 0, kp: 0, kd: 0, effort: 0, confirmation: "",
    });
  });
});

describe("STM32 fault catalog", () => {
  it("documents every firmware fault 0 through 11", () => {
    expect(Object.keys(motorFaults).map(Number)).toEqual([...Array(12).keys()]);
    expect(faultInfo(3)).toMatchObject({ name: "COMMAND_LIMIT" });
    expect(faultInfo(11).description).toContain("重启 STM32");
    expect(faultInfo(99).name).toBe("UNKNOWN");
  });
});
