import { describe, expect, it } from "vitest";
import { defaultProfile } from "./types";
import {
  activeControllers,
  buildStatusCards,
  buildStatusQuickActions,
  buildUsbCard,
  faultFailureReason,
  formatFaultCode,
  formatHardwareMode,
  formatHz,
  HOLD_NO_GRAVITY_HINT,
  isHardwareHold,
  VLA_ONE_CLICK_RISK_WARNING,
} from "./statusLogic";

describe("statusLogic", () => {
  it("formats hz, fault, and mode helpers", () => {
    expect(formatHz(undefined)).toBe("—");
    expect(formatHz(0)).toBe("—");
    expect(formatHz(12.34)).toBe("12.3 Hz");
    expect(formatFaultCode(0)).toBe("0 · NONE");
    expect(formatFaultCode(6)).toContain("FEEDBACK_TIMEOUT");
    expect(faultFailureReason(6)).toContain("超时");
    expect(faultFailureReason(0)).toBeUndefined();
    expect(formatHardwareMode(null)).toBe("—");
    expect(formatHardwareMode({ mode: 0 })).toBe("HOLD");
    expect(formatHardwareMode({ mode: 1, mode_name: "TRACK" })).toBe("TRACK");
    expect(faultFailureReason(11)).toContain("需先安全回零/托住，再重启 STM32");
    expect(isHardwareHold({ mode: 0, fault_code: 0 })).toBe(true);
    expect(isHardwareHold({ mode: 1, mode_name: "HOLD", fault_code: 0 })).toBe(true);
    expect(isHardwareHold({ mode: 1, mode_name: "TRACK", fault_code: 0 })).toBe(false);
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

  it("builds USB card with refresh action and MCU detail", () => {
    const missing = buildUsbCard({ sshOk: true, usbProbe: {
      mcuPresent: false,
      mcuVidPid: "",
      realsensePresent: false,
      realsenseLines: [],
      rawLsusb: "",
    }, usbChecked: true });
    expect(missing.tone).toBe("fail");
    expect(missing.failureReason).toContain("0483:5740");
    expect(missing.actions?.[0]).toMatchObject({ id: "usb-refresh", kind: "refresh" });

    const ok = buildUsbCard({
      sshOk: true,
      usbChecked: true,
      usbProbe: {
        mcuPresent: true,
        mcuVidPid: "0483:5740",
        serialPath: "/dev/ttyACM0",
        realsensePresent: true,
        realsenseLines: ["Bus 001 Device 004: ID 8086:0b3a"],
        rawLsusb: "0483:5740",
      },
    });
    expect(ok.tone).toBe("ok");
    expect(ok.detail).toContain("0483:5740");
    expect(ok.detail).toContain("/dev/ttyACM0");
  });

  it("builds the full card set including Teleop/Trajectory/RealSense actions", () => {
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
      usbProbe: {
        mcuPresent: true,
        mcuVidPid: "0483:5740",
        serialPath: "/dev/serial/by-id/usb-STM",
        realsensePresent: true,
        realsenseLines: ["8086:0b3a"],
        rawLsusb: "0483:5740",
      },
      usbChecked: true,
      armMode: {
        mode: "teleop",
        teleopRunning: true,
        trajectoryRunning: false,
        realsenseRunning: false,
        teleopPid: 99,
        trajectoryPid: 0,
        realsensePid: 0,
        message: "ok",
      },
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
      "teleop",
      "trajectory",
      "vla",
      "realsense",
    ]);
    expect(cards.find((card) => card.id === "hardware")?.detail).toContain("无故障");
    expect(cards.find((card) => card.id === "hardware")?.tone).toBe("ok");
    expect(cards.find((card) => card.id === "vla")?.warning).toBe(VLA_ONE_CLICK_RISK_WARNING);
    expect(cards.find((card) => card.id === "agent")?.actions?.[0]?.id).toBe("agent-restart");
    expect(cards.find((card) => card.id === "teleop")?.actions?.[0]?.kind).toBe("restart");
    expect(cards.find((card) => card.id === "usb")?.summary).toContain("0483:5740");
    expect(cards.find((card) => card.id === "ros-ready")?.summary).toContain("冒烟");
    expect(cards.find((card) => card.id === "dds")?.tone).toBe("ok");
  });

  it("gates Teleop/Trajectory restart until ROS-ready and exposes quick actions", () => {
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
      hardwareStatus: { fault_code: 6, mode: 0, mode_name: "HOLD" },
      jointState: null,
      jointStateSample: undefined,
      jointStateTopic: "/stm32/joint_states",
      rosControl: null,
      lastKnownDomainId: 0,
      usbChecked: true,
      usbProbe: { mcuPresent: false, mcuVidPid: "", realsensePresent: false, realsenseLines: [], rawLsusb: "" },
    });
    expect(cards.find((card) => card.id === "dds")?.tone).toBe("warn");
    expect(cards.find((card) => card.id === "ros-ready")?.tone).toBe("warn");
    expect(cards.find((card) => card.id === "teleop")?.actions?.[0]?.disabled).toBe(true);
    expect(cards.find((card) => card.id === "hardware")?.failureReason).toContain("超时");
    expect(cards.find((card) => card.id === "agent")?.actions?.[0]?.disabled).toBe(false);

    const quick = buildStatusQuickActions({ sshOk: true, rosReady: false });
    expect(quick.find((item) => item.id === "teleop")?.disabled).toBe(true);
    expect(buildStatusQuickActions({ sshOk: true, rosReady: true }).find((item) => item.id === "teleop")?.disabled).toBe(false);
  });

  it("builds VLA card from controller active + chunk Hz and gates quick actions", () => {
    const inactive = buildStatusCards({
      stage: "connected",
      sshOk: true,
      bridgeUp: true,
      localPort: 18765,
      remotePort: 8765,
      profile: { ...defaultProfile },
      hello: null,
      agentStatus: null,
      agentError: "",
      agentChecked: true,
      hardwareStatus: null,
      jointState: { name: ["j1"], position: [0] },
      jointStateSample: undefined,
      jointStateTopic: "/stm32/joint_states",
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "vla_position_controller", typeName: "microros_stm32h723_bridge/VlaPositionController", state: "inactive" },
          { name: "gravity_compensation_controller", typeName: "t", state: "active" },
          { name: "arm_teleop_controller", typeName: "t", state: "active" },
        ],
        message: "",
      },
      lastKnownDomainId: 0,
    });
    const vla = inactive.find((card) => card.id === "vla")!;
    expect(vla.tone).toBe("warn");
    expect(vla.actions?.map((action) => action.id)).toEqual(["vla-start", "vla-stop"]);
    expect(vla.actions?.find((action) => action.id === "vla-start")?.disabled).toBe(false);
    expect(vla.actions?.find((action) => action.id === "vla-stop")?.disabled).toBe(true);

    const active = buildStatusCards({
      stage: "connected",
      sshOk: true,
      bridgeUp: true,
      localPort: 18765,
      remotePort: 8765,
      profile: { ...defaultProfile },
      hello: null,
      agentStatus: null,
      agentError: "",
      agentChecked: true,
      hardwareStatus: null,
      jointState: { name: ["j1"], position: [0] },
      jointStateSample: undefined,
      jointStateTopic: "/stm32/joint_states",
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "vla_position_controller", typeName: "t", state: "active" },
          { name: "gravity_compensation_controller", typeName: "t", state: "active" },
        ],
        message: "",
      },
      lastKnownDomainId: 0,
      vlaChunkSample: { data: {}, count: 20, firstAt: 0, lastAt: 1000, hz: 10 },
    });
    const running = active.find((card) => card.id === "vla")!;
    expect(running.tone).toBe("ok");
    expect(running.summary).toContain("10");
    expect(running.actions?.find((action) => action.id === "vla-start")?.disabled).toBe(true);
    expect(running.actions?.find((action) => action.id === "vla-stop")?.disabled).toBe(false);
    expect(active.find((card) => card.id === "teleop")?.actions?.[0]?.disabled).toBe(true);

    const quick = buildStatusQuickActions({ sshOk: true, rosReady: true, vlaActive: true });
    expect(quick.find((item) => item.id === "vla")?.disabled).toBe(true);
    expect(quick.find((item) => item.id === "teleop")?.disabled).toBe(true);
    expect(quick.find((item) => item.id === "stop")?.label).toContain("VLA");
  });

  it("uses caution tone for HOLD with fault_code 0 and keeps TRACK ok", () => {
    const hold = buildStatusCards({
      stage: "connected",
      sshOk: true,
      bridgeUp: true,
      localPort: 18765,
      remotePort: 8765,
      profile: { ...defaultProfile },
      hello: null,
      agentStatus: null,
      agentError: "",
      agentChecked: true,
      hardwareStatus: { mode: 0, mode_name: "HOLD", fault_code: 0 },
      jointState: { name: ["j1"], position: [0] },
      jointStateSample: undefined,
      jointStateTopic: "/stm32/joint_states",
      rosControl: null,
      lastKnownDomainId: 0,
    }).find((card) => card.id === "hardware")!;
    expect(hold.tone).toBe("warn");
    expect(hold.detail).toContain(HOLD_NO_GRAVITY_HINT);
    expect(hold.warning).toBe(HOLD_NO_GRAVITY_HINT);
    expect(hold.failureReason).toBeUndefined();

    const track = buildStatusCards({
      stage: "connected",
      sshOk: true,
      bridgeUp: true,
      localPort: 18765,
      remotePort: 8765,
      profile: { ...defaultProfile },
      hello: null,
      agentStatus: null,
      agentError: "",
      agentChecked: true,
      hardwareStatus: { mode: 1, mode_name: "TRACK", fault_code: 0 },
      jointState: null,
      jointStateSample: undefined,
      jointStateTopic: "/stm32/joint_states",
      rosControl: null,
      lastKnownDomainId: 0,
    }).find((card) => card.id === "hardware")!;
    expect(track.tone).toBe("ok");
    expect(track.warning).toBeUndefined();
    expect(track.detail).toContain("无故障");
  });
});
