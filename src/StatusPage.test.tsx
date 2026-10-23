import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { StatusPage } from "./StatusPage";

const baseProps = {
  stage: "connected",
  sshOk: true,
  bridgeUp: true,
  localPort: 18765,
  profile: { ...defaultProfile, name: "desk" },
  hello: { bridgeVersion: "0.1.0", rosDistro: "humble" },
  agentStatus: {
    loadState: "loaded",
    activeState: "active",
    subState: "running",
    result: "success",
    mainPid: 9,
    unitFileState: "enabled",
    description: "agent",
  },
  agentError: "",
  agentChecked: true,
  hardwareStatus: { mode: 0, mode_name: "HOLD", fault_code: 0, last_command_sequence: 42 },
  jointState: { name: ["j1"], position: [0.1] },
  jointStateSample: { data: {}, count: 3, firstAt: 0, lastAt: 500, hz: 4 },
  rosControl: {
    manager: "/controller_manager",
    available: true,
    controllers: [{ name: "forward_position_controller", typeName: "t", state: "active" }],
    message: "",
  },
  lastKnownDomainId: 0,
  usbChecked: true,
  usbProbe: {
    mcuPresent: true,
    mcuVidPid: "0483:5740",
    serialPath: "/dev/ttyACM0",
    realsensePresent: false,
    realsenseLines: [],
    rawLsusb: "0483:5740",
  },
  armMode: {
    mode: "idle" as const,
    teleopRunning: false,
    trajectoryRunning: false,
    realsenseRunning: false,
    teleopPid: 0,
    trajectoryPid: 0,
    realsensePid: 0,
    teleopOwnsRos2Control: false,
    trajectoryOwnsRos2Control: false,
    message: "",
  },
};

describe("StatusPage", () => {
  it("renders four-zone layout with sticky HOLD alert and exclusive mode strip", async () => {
    const user = userEvent.setup();
    const onCardAction = vi.fn();
    const onQuickAction = vi.fn();
    render(
      <StatusPage
        {...baseProps}
        onCardAction={onCardAction}
        onQuickAction={onQuickAction}
      />,
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeVisible();
    expect(screen.getByLabelText("状态分区")).toBeVisible();
    expect(screen.getByLabelText("连接")).toBeVisible();
    expect(screen.getByLabelText("硬件健康")).toBeVisible();
    expect(screen.getByLabelText("控制模式")).toBeVisible();
    expect(screen.getByText("传感器 / 高级")).toBeVisible();

    expect(screen.getByLabelText("SSH / 隧道")).toBeVisible();
    expect(screen.getByLabelText("Bridge")).toBeVisible();
    expect(screen.getByLabelText("micro-ROS Agent")).toBeVisible();
    expect(screen.getByLabelText("Hardware")).toBeVisible();
    expect(screen.getByLabelText("ROS 就绪")).toBeVisible();
    expect(screen.getByLabelText("ros2_control")).toBeVisible();
    expect(screen.getByLabelText("USB CDC / ACM")).toBeVisible();
    expect(screen.queryByLabelText("DDS Domain")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("systemd")).not.toBeInTheDocument();

    expect(screen.getByTestId("status-sticky-alert")).toHaveTextContent(/无重力补偿/);
    expect(screen.getByTestId("status-sticky-alert")).toHaveAttribute("data-kind", "hold");
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByText("localhost:18765")).toBeVisible();
    expect(screen.getByTestId("status-detail-hardware")).toHaveTextContent(/无重力补偿/);
    expect(screen.getByTestId("status-mode-idle")).toBeVisible();
    expect(screen.queryByLabelText("Teleop")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Teleop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Trajectory" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "VLA" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "解除输出" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "刷新检测" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Teleop" }));
    expect(onQuickAction).toHaveBeenCalledWith("teleop");
    await user.click(screen.getByRole("button", { name: "VLA" }));
    expect(onQuickAction).toHaveBeenCalledWith("vla");
    await user.click(screen.getByRole("button", { name: "解除输出" }));
    expect(screen.getByRole("dialog", { name: "解除电机输出确认" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认 DISABLE 并停止" })).toBeDisabled();
    expect(onQuickAction).not.toHaveBeenCalledWith("disable-stop");
    await user.click(screen.getByRole("checkbox", { name: "机械臂已支撑，可以解除输出" }));
    await user.click(screen.getByRole("button", { name: "确认 DISABLE 并停止" }));
    expect(onQuickAction).toHaveBeenCalledWith("disable-stop");
    expect(screen.queryByRole("dialog", { name: "解除电机输出确认" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "刷新检测" }));
    expect(onCardAction).toHaveBeenCalled();
    expect(onCardAction.mock.calls[0][0].id).toBe("usb-refresh");
  });

  it("shows only the active mode detail and marks the strip segment pressed", () => {
    render(
      <StatusPage
        {...baseProps}
        hardwareStatus={{ mode: 1, mode_name: "TRACK", fault_code: 0, last_command_sequence: 9 }}
        armMode={{
          ...baseProps.armMode,
          mode: "teleop",
          teleopRunning: true,
          teleopPid: 99,
        }}
      />,
    );
    expect(screen.queryByTestId("status-sticky-alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Teleop")).toBeVisible();
    expect(screen.queryByLabelText("Trajectory / MoveIt")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("VLA")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Teleop" })).toHaveAttribute("aria-pressed", "true");
    // Mode cards no longer expose primary restart; Agent/RealSense may still offer 重新拉起.
    expect(screen.queryByLabelText("Teleop 操作")).not.toBeInTheDocument();
  });

  it("surfaces disabledReasons as on-page hints for gated quick actions", () => {
    render(
      <StatusPage
        stage="connected"
        sshOk={false}
        bridgeUp={false}
        localPort={null}
        profile={{ ...defaultProfile, name: "desk" }}
        hello={null}
        agentStatus={null}
        agentError=""
        agentChecked={false}
        hardwareStatus={null}
        jointState={null}
        jointStateSample={undefined}
        rosControl={null}
        lastKnownDomainId={null}
      />,
    );
    expect(screen.getByRole("button", { name: "Teleop" })).toBeDisabled();
    expect(screen.getByTestId("status-quick-disabled-teleop")).toHaveTextContent("SSH 未就绪");
    expect(screen.getByTestId("status-disabled-usb-usb-refresh")).toHaveTextContent("SSH 未就绪");
  });
});
