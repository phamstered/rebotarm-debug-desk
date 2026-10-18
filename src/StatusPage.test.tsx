import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { StatusPage } from "./StatusPage";

describe("StatusPage", () => {
  it("renders status grid with detail, failure reasons, and action buttons", async () => {
    const user = userEvent.setup();
    const onCardAction = vi.fn();
    const onQuickAction = vi.fn();
    render(
      <StatusPage
        stage="connected"
        sshOk
        bridgeUp
        localPort={18765}
        profile={{ ...defaultProfile, name: "desk" }}
        hello={{ bridgeVersion: "0.1.0", rosDistro: "humble" }}
        agentStatus={{
          loadState: "loaded",
          activeState: "active",
          subState: "running",
          result: "success",
          mainPid: 9,
          unitFileState: "enabled",
          description: "agent",
        }}
        agentError=""
        agentChecked
        hardwareStatus={{ mode: 0, mode_name: "HOLD", fault_code: 0 }}
        jointState={{ name: ["j1"], position: [0.1] }}
        jointStateSample={{ data: {}, count: 3, firstAt: 0, lastAt: 500, hz: 4 }}
        rosControl={{
          manager: "/controller_manager",
          available: true,
          controllers: [{ name: "forward_position_controller", typeName: "t", state: "active" }],
          message: "",
        }}
        lastKnownDomainId={0}
        usbChecked
        usbProbe={{
          mcuPresent: true,
          mcuVidPid: "0483:5740",
          serialPath: "/dev/ttyACM0",
          realsensePresent: false,
          realsenseLines: [],
          rawLsusb: "0483:5740",
        }}
        armMode={{
          mode: "idle",
          teleopRunning: false,
          trajectoryRunning: false,
          realsenseRunning: false,
          teleopPid: 0,
          trajectoryPid: 0,
          realsensePid: 0,
          message: "",
        }}
        onCardAction={onCardAction}
        onQuickAction={onQuickAction}
      />,
    );

    expect(screen.getByRole("heading", { name: "Status" })).toBeVisible();
    expect(screen.getByText(/一键 Teleop\/Trajectory\/VLA/)).toBeVisible();
    expect(screen.getByLabelText("状态卡片")).toBeVisible();
    expect(screen.getByLabelText("SSH / 隧道")).toBeVisible();
    expect(screen.getByLabelText("Bridge")).toBeVisible();
    expect(screen.getByLabelText("micro-ROS Agent")).toBeVisible();
    expect(screen.getByLabelText("Hardware")).toBeVisible();
    expect(screen.getByLabelText("ROS 就绪")).toBeVisible();
    expect(screen.getByLabelText("ros2_control")).toBeVisible();
    expect(screen.getByLabelText("DDS Domain")).toBeVisible();
    expect(screen.getByLabelText("systemd")).toBeVisible();
    expect(screen.getByLabelText("USB CDC / 传输")).toBeVisible();
    expect(screen.getByLabelText("Teleop")).toBeVisible();
    expect(screen.getByLabelText("Trajectory / MoveIt")).toBeVisible();
    expect(screen.getByLabelText("VLA")).toBeVisible();
    expect(screen.getByLabelText("RealSense")).toBeVisible();
    expect(screen.getByText("localhost:18765")).toBeVisible();
    expect(screen.getByText("HOLD")).toBeVisible();
    expect(screen.getAllByText("forward_position_controller").length).toBeGreaterThan(0);
    expect(screen.getByTestId("status-detail-hardware")).toHaveTextContent(/无故障/);
    expect(screen.getByRole("button", { name: "一键 Teleop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "一键 Trajectory" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "一键 VLA" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "刷新检测" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "一键 Teleop" }));
    expect(onQuickAction).toHaveBeenCalledWith("teleop");
    await user.click(screen.getByRole("button", { name: "一键 VLA" }));
    expect(onQuickAction).toHaveBeenCalledWith("vla");
    await user.click(screen.getByRole("button", { name: "刷新检测" }));
    expect(onCardAction).toHaveBeenCalled();
    expect(onCardAction.mock.calls[0][0].id).toBe("usb-refresh");
  });
});
