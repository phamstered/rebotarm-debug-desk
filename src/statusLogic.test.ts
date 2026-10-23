import { describe, expect, it } from "vitest";
import { defaultProfile } from "./types";
import {
  activeControllers,
  buildHardwareStickyAlert,
  buildStatusCards,
  buildStatusQuickActions,
  buildUsbCard,
  faultFailureReason,
  formatFaultCode,
  formatHardwareMode,
  formatHz,
  formatLastCommandSequence,
  FAULT_11_HARD_FAIL_COPY,
  HOLD_NO_GRAVITY_HINT,
  fault11StartBlockReason,
  groupStatusZones,
  isFault11Latched,
  isHardwareHold,
  resolveActiveControlMode,
  VLA_ONE_CLICK_RISK_WARNING,
} from "./statusLogic";

const baseCardInput = {
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
  hardwareStatus: { mode: 1, mode_name: "TRACK", fault_code: 0, last_command_sequence: 17 },
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
    mode: "teleop" as const,
    teleopRunning: true,
    trajectoryRunning: false,
    realsenseRunning: false,
    teleopPid: 99,
    trajectoryPid: 0,
    realsensePid: 0,
    teleopOwnsRos2Control: true,
    trajectoryOwnsRos2Control: false,
    message: "ok",
  },
};

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
    expect(formatLastCommandSequence({ last_command_sequence: 17 })).toBe("17");
    expect(formatLastCommandSequence(null)).toBe("—");
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

  it("builds MCU-only USB card in hardware zone (no RealSense USB row)", () => {
    const missing = buildUsbCard({ sshOk: true, usbProbe: {
      mcuPresent: false,
      mcuVidPid: "",
      realsensePresent: false,
      realsenseLines: [],
      rawLsusb: "",
    }, usbChecked: true });
    expect(missing.tone).toBe("fail");
    expect(missing.title).toContain("USB CDC");
    expect(missing.failureReason).toContain("0483:5740");
    expect(missing.rows.some((row) => row.label.includes("RealSense"))).toBe(false);
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
    expect(ok.rows.some((row) => row.label.includes("RealSense"))).toBe(false);
  });

  it("groups cards into four zones with USB under hardware health", () => {
    const cards = buildStatusCards(baseCardInput);
    expect(cards.map((card) => card.id)).toEqual([
      "ssh",
      "bridge",
      "agent",
      "hardware",
      "ros-ready",
      "ros2-control",
      "usb",
      "teleop",
      "trajectory",
      "vla",
      "realsense",
    ]);
    expect(cards.find((card) => card.id === "dds")).toBeUndefined();
    expect(cards.find((card) => card.id === "systemd")).toBeUndefined();

    const zones = groupStatusZones(cards);
    expect(zones.map((zone) => zone.id)).toEqual(["connection", "hardware", "control", "sensors"]);
    expect(zones.find((zone) => zone.id === "hardware")?.primary).toBe(true);
    expect(zones.find((zone) => zone.id === "hardware")?.cards.map((card) => card.id)).toEqual([
      "usb",
      "hardware",
      "ros2-control",
      "ros-ready",
    ]);
    expect(zones.find((zone) => zone.id === "connection")?.cards.map((card) => card.id)).toEqual([
      "ssh",
      "bridge",
      "agent",
    ]);
    expect(zones.find((zone) => zone.id === "sensors")?.cards.map((card) => card.id)).toEqual(["realsense"]);

    const hardware = cards.find((card) => card.id === "hardware")!;
    expect(hardware.detail).toContain("无故障");
    expect(hardware.tone).toBe("ok");
    expect(hardware.rows.find((row) => row.label === "last_command_sequence")?.value).toBe("17");

    const bridge = cards.find((card) => card.id === "bridge")!;
    expect(bridge.rows.some((row) => row.label === "DDS Domain")).toBe(true);
    expect(bridge.rows.some((row) => row.label === "最近部署")).toBe(false);

    const agent = cards.find((card) => card.id === "agent")!;
    expect(agent.rows.some((row) => row.label.includes("systemd"))).toBe(true);
    expect(agent.rows.some((row) => row.label.includes("XRCE"))).toBe(false);
    expect(agent.actions?.[0]?.id).toBe("agent-restart");

    expect(cards.find((card) => card.id === "teleop")?.actions).toBeUndefined();
    expect(cards.find((card) => card.id === "trajectory")?.actions).toBeUndefined();
    expect(cards.find((card) => card.id === "vla")?.actions).toBeUndefined();
    expect(cards.find((card) => card.id === "usb")?.summary).toContain("0483:5740");
    expect(cards.find((card) => card.id === "ros-ready")?.summary).toContain("冒烟");
  });

  it("keeps idle control modes on idle tone and resolves active mode", () => {
    const cards = buildStatusCards({
      ...baseCardInput,
      armMode: {
        ...baseCardInput.armMode,
        mode: "idle",
        teleopRunning: false,
        teleopPid: 0,
        teleopOwnsRos2Control: false,
      },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [{ name: "vla_position_controller", typeName: "t", state: "inactive" }],
        message: "",
      },
    });
    expect(cards.find((card) => card.id === "teleop")?.tone).toBe("idle");
    expect(cards.find((card) => card.id === "trajectory")?.tone).toBe("idle");
    expect(cards.find((card) => card.id === "vla")?.tone).toBe("idle");
    // list_controllers available but no position controller active → ignore script PID flags (#106)
    expect(resolveActiveControlMode({
      armMode: baseCardInput.armMode,
      rosControl: baseCardInput.rosControl,
    })).toBeNull();
    expect(resolveActiveControlMode({
      armMode: { ...baseCardInput.armMode, teleopRunning: false },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [{ name: "vla_position_controller", typeName: "t", state: "active" }],
        message: "",
      },
    })).toBe("vla");
  });

  it("prefers list_controllers position controller over script PID flags for strip selection", () => {
    const teleopCtrl = {
      manager: "/controller_manager",
      available: true,
      controllers: [
        { name: "arm_teleop_controller", typeName: "t", state: "active" },
        { name: "gravity_compensation_controller", typeName: "t", state: "active" },
      ],
      message: "",
    };
    expect(resolveActiveControlMode({
      armMode: { ...baseCardInput.armMode, teleopRunning: false, trajectoryRunning: true },
      rosControl: teleopCtrl,
    })).toBe("teleop");

    expect(resolveActiveControlMode({
      armMode: { ...baseCardInput.armMode, teleopRunning: true, trajectoryRunning: false },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "arm_trajectory_controller", typeName: "t", state: "active" },
          { name: "arm_teleop_controller", typeName: "t", state: "inactive" },
        ],
        message: "",
      },
    })).toBe("trajectory");

    // When ros2_control unavailable, fall back to script flags
    expect(resolveActiveControlMode({
      armMode: { ...baseCardInput.armMode, teleopRunning: true },
      rosControl: { manager: "/controller_manager", available: false, controllers: [], message: "offline" },
    })).toBe("teleop");
    expect(resolveActiveControlMode({
      armMode: { ...baseCardInput.armMode, teleopRunning: false, trajectoryRunning: true },
      rosControl: null,
    })).toBe("trajectory");
  });

  it("shows real controller names and Gravity row on all three mode details", () => {
    const teleopCards = buildStatusCards({
      ...baseCardInput,
      armMode: { ...baseCardInput.armMode, mode: "teleop", teleopRunning: true, teleopPid: 99 },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "arm_teleop_controller", typeName: "t", state: "active" },
          { name: "gravity_compensation_controller", typeName: "t", state: "inactive" },
        ],
        message: "",
      },
    });
    const teleop = teleopCards.find((card) => card.id === "teleop")!;
    expect(teleop.rows.find((row) => row.label === "控制器")?.value).toBe("arm_teleop_controller");
    expect(teleop.rows.find((row) => row.label === "Gravity")?.tone).toBe("warn");
    expect(teleop.warning).toContain("gravity_compensation_controller");

    const trajCards = buildStatusCards({
      ...baseCardInput,
      armMode: { ...baseCardInput.armMode, mode: "trajectory", teleopRunning: false, teleopPid: 0, trajectoryRunning: true, trajectoryPid: 55 },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "arm_trajectory_controller", typeName: "t", state: "active" },
          { name: "gravity_compensation_controller", typeName: "t", state: "active" },
        ],
        message: "",
      },
    });
    const traj = trajCards.find((card) => card.id === "trajectory")!;
    expect(traj.rows.find((row) => row.label === "控制器")?.value).toBe("arm_trajectory_controller");
    expect(traj.rows.find((row) => row.label === "Gravity")?.value).toContain("active");
    expect(traj.rows.find((row) => row.label === "Gravity")?.tone).toBe("ok");
    expect(traj.warning).toBeUndefined();

    const vlaCards = buildStatusCards({
      ...baseCardInput,
      armMode: { ...baseCardInput.armMode, mode: "idle", teleopRunning: false, teleopPid: 0 },
      hardwareStatus: { mode: 1, mode_name: "TRACK", fault_code: 0 },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "vla_position_controller", typeName: "t", state: "active" },
          { name: "gravity_compensation_controller", typeName: "t", state: "inactive" },
        ],
        message: "",
      },
    });
    const vla = vlaCards.find((card) => card.id === "vla")!;
    expect(vla.rows.find((row) => row.label === "Gravity")?.tone).toBe("warn");
    expect(vla.warning).toContain("gravity_compensation_controller");
    expect(vla.tone).toBe("warn");
  });

  it("builds sticky alerts for HOLD / fault / fault 11", () => {
    expect(buildHardwareStickyAlert(null)).toBeNull();
    expect(buildHardwareStickyAlert({ mode: 1, mode_name: "TRACK", fault_code: 0 })).toBeNull();
    expect(buildHardwareStickyAlert({ mode: 0, mode_name: "HOLD", fault_code: 0 })).toMatchObject({
      kind: "hold",
      tone: "warn",
      message: HOLD_NO_GRAVITY_HINT,
    });
    expect(buildHardwareStickyAlert({ mode: 0, mode_name: "HOLD", fault_code: 6 })).toMatchObject({
      kind: "fault",
      tone: "fail",
    });
    expect(buildHardwareStickyAlert({ mode: 0, mode_name: "HOLD", fault_code: 11 })).toMatchObject({
      kind: "fault11",
      tone: "fail",
      message: FAULT_11_HARD_FAIL_COPY,
    });
  });

  it("gates quick actions until ROS-ready and folds DDS warn into Bridge", () => {
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
    expect(cards.find((card) => card.id === "bridge")?.tone).toBe("warn");
    expect(cards.find((card) => card.id === "ros-ready")?.tone).toBe("warn");
    expect(cards.find((card) => card.id === "teleop")?.actions).toBeUndefined();
    expect(cards.find((card) => card.id === "hardware")?.failureReason).toContain("超时");
    expect(cards.find((card) => card.id === "agent")?.actions?.[0]?.disabled).toBe(false);

    const quick = buildStatusQuickActions({ sshOk: true, rosReady: false });
    expect(quick.find((item) => item.id === "teleop")?.disabled).toBe(true);
    expect(buildStatusQuickActions({ sshOk: true, rosReady: true }).find((item) => item.id === "teleop")?.disabled).toBe(false);
  });

  it("marks VLA TRACK latch and keeps risk warning only when idle", () => {
    const inactive = buildStatusCards({
      ...baseCardInput,
      armMode: { ...baseCardInput.armMode, mode: "idle", teleopRunning: false, teleopPid: 0, teleopOwnsRos2Control: false },
      hardwareStatus: null,
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
    });
    const vla = inactive.find((card) => card.id === "vla")!;
    expect(vla.tone).toBe("idle");
    expect(vla.actions).toBeUndefined();
    expect(vla.warning).toBe(VLA_ONE_CLICK_RISK_WARNING);

    const activeTrack = buildStatusCards({
      ...baseCardInput,
      armMode: { ...baseCardInput.armMode, mode: "idle", teleopRunning: false, teleopPid: 0, teleopOwnsRos2Control: false },
      hardwareStatus: { mode: 1, mode_name: "TRACK", fault_code: 0 },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "vla_position_controller", typeName: "t", state: "active" },
          { name: "gravity_compensation_controller", typeName: "t", state: "active" },
        ],
        message: "",
      },
      vlaChunkSample: { data: {}, count: 20, firstAt: 0, lastAt: 1000, hz: 10 },
    });
    const running = activeTrack.find((card) => card.id === "vla")!;
    expect(running.tone).toBe("ok");
    expect(running.summary).toContain("TRACK");
    expect(running.rows.find((row) => row.label === "固件闩锁")?.value).toBe("TRACK");
    expect(running.warning).toBeUndefined();

    const activeHold = buildStatusCards({
      ...baseCardInput,
      armMode: { ...baseCardInput.armMode, mode: "idle", teleopRunning: false, teleopPid: 0, teleopOwnsRos2Control: false },
      hardwareStatus: { mode: 0, mode_name: "HOLD", fault_code: 0 },
      rosControl: {
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "vla_position_controller", typeName: "t", state: "active" },
          { name: "gravity_compensation_controller", typeName: "t", state: "active" },
        ],
        message: "",
      },
    });
    const holdLatch = activeHold.find((card) => card.id === "vla")!;
    expect(holdLatch.tone).toBe("warn");
    expect(holdLatch.rows.find((row) => row.label === "固件闩锁")?.value).toContain("HOLD");

    const quick = buildStatusQuickActions({ sshOk: true, rosReady: true, vlaActive: true });
    expect(quick.find((item) => item.id === "vla")?.disabled).toBe(true);
    expect(quick.find((item) => item.id === "teleop")?.disabled).toBe(true);
    expect(quick.find((item) => item.id === "stop")?.label).toBe("停止");
  });

  it("uses caution tone for HOLD with fault_code 0 and keeps TRACK ok", () => {
    const hold = buildStatusCards({
      ...baseCardInput,
      hardwareStatus: { mode: 0, mode_name: "HOLD", fault_code: 0 },
      rosControl: null,
    }).find((card) => card.id === "hardware")!;
    expect(hold.tone).toBe("warn");
    expect(hold.detail).toContain(HOLD_NO_GRAVITY_HINT);
    expect(hold.warning).toBe(HOLD_NO_GRAVITY_HINT);
    expect(hold.failureReason).toBeUndefined();

    const track = buildStatusCards({
      ...baseCardInput,
      hardwareStatus: { mode: 1, mode_name: "TRACK", fault_code: 0 },
      jointState: null,
      jointStateSample: undefined,
      rosControl: null,
    }).find((card) => card.id === "hardware")!;
    expect(track.tone).toBe("ok");
    expect(track.warning).toBeUndefined();
    expect(track.detail).toContain("无故障");
  });

  it("disables Teleop/Trajectory/VLA starts on fault_code 11 via quick actions", () => {
    expect(isFault11Latched({ fault_code: 11 })).toBe(true);
    expect(fault11StartBlockReason({ fault_code: 11 })).toBe(FAULT_11_HARD_FAIL_COPY);
    expect(fault11StartBlockReason({ fault_code: 0 })).toBeUndefined();

    const quick = buildStatusQuickActions({
      sshOk: true,
      rosReady: true,
      hardwareStatus: { fault_code: 11 },
    });
    expect(quick.find((item) => item.id === "teleop")?.disabled).toBe(true);
    expect(quick.find((item) => item.id === "vla")?.disabledReason).toBe(FAULT_11_HARD_FAIL_COPY);
    expect(quick.find((item) => item.id === "stop")?.disabled).toBe(false);
    expect(quick.find((item) => item.id === "teleop")?.label).toBe("Teleop");
  });
});
