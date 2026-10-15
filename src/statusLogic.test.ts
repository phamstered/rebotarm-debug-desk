import { describe, expect, it } from "vitest";
import { defaultProfile } from "./types";
import {
  activeControllers,
  buildStatusCards,
  formatFaultCode,
  formatHardwareMode,
  formatHz,
} from "./statusLogic";

describe("statusLogic", () => {
  it("formats hz, fault, and mode helpers", () => {
    expect(formatHz(undefined)).toBe("—");
    expect(formatHz(0)).toBe("—");
    expect(formatHz(12.34)).toBe("12.3 Hz");
    expect(formatFaultCode(0)).toBe("0 · NONE");
    expect(formatFaultCode(6)).toContain("FEEDBACK_TIMEOUT");
    expect(formatHardwareMode(null)).toBe("—");
    expect(formatHardwareMode({ mode: 0 })).toBe("HOLD");
    expect(formatHardwareMode({ mode: 1, mode_name: "TRACK" })).toBe("TRACK");
  });

  it("lists active controllers", () => {
    expect(activeControllers(null)).toEqual([]);
    expect(activeControllers({
      manager: "/controller_manager",
      available: true,
      controllers: [
        { name: "a", typeName: "t", state: "active" },
        { name: "b", typeName: "t", state: "inactive" },
      ],
      message: "",
    })).toEqual(["a"]);
  });

  it("builds the full read-only card set with unknown USB/deploy fields", () => {
    const cards = buildStatusCards({
      stage: "connected",
      sshOk: true,
      bridgeUp: true,
      localPort: 18765,
      remotePort: 8765,
      profile: { ...defaultProfile, host: "jetson", name: "jetson", rosDomainId: 0 },
      hello: { bridgeVersion: "0.1.0", bridgeBuildId: "abc", rosDistro: "humble" },
      agentStatus: {
        loadState: "loaded",
        activeState: "active",
        subState: "running",
        result: "success",
        mainPid: 42,
        unitFileState: "enabled",
        description: "micro-ROS agent",
      },
      agentError: "",
      agentChecked: true,
      hardwareStatus: { mode: 1, mode_name: "TRACK", fault_code: 0 },
      jointState: { name: ["j1"], position: [0] },
      jointStateSample: { data: {}, count: 10, firstAt: 0, lastAt: 1000, hz: 9.5 },
      jointStateTopic: "/stm32/joint_states",
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [{ name: "joint_trajectory_controller", typeName: "t", state: "active" }],
        message: "",
      },
      lastKnownDomainId: 0,
    });

    expect(cards.map((card) => card.id)).toEqual([
      "ssh",
      "bridge",
      "agent",
      "hardware",
      "ros-ready",
      "ros2-control",
      "dds",
      "systemd",
      "usb",
    ]);
    expect(cards.find((card) => card.id === "bridge")?.rows.find((row) => row.label === "最近部署")?.value).toBe("未知");
    expect(cards.find((card) => card.id === "usb")?.summary).toBe("未知");
    expect(cards.find((card) => card.id === "ros-ready")?.summary).toContain("冒烟");
    expect(cards.find((card) => card.id === "dds")?.tone).toBe("ok");
  });

  it("warns on domain mismatch and missing joint state", () => {
    const cards = buildStatusCards({
      stage: "connected",
      sshOk: true,
      bridgeUp: true,
      localPort: null,
      remotePort: 8765,
      profile: { ...defaultProfile, rosDomainId: 7 },
      hello: null,
      agentStatus: null,
      agentError: "",
      agentChecked: false,
      hardwareStatus: null,
      jointState: null,
      jointStateSample: undefined,
      jointStateTopic: "/stm32/joint_states",
      rosControl: null,
      lastKnownDomainId: 0,
    });
    expect(cards.find((card) => card.id === "dds")?.tone).toBe("warn");
    expect(cards.find((card) => card.id === "ros-ready")?.tone).toBe("warn");
    expect(cards.find((card) => card.id === "bridge")?.rows.find((row) => row.label === "bridge_version")?.value).toBe("未知");
  });
});
