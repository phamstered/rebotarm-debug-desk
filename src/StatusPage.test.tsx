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
  it("renders four status tabs with sticky HOLD alert and exclusive mode strip", async () => {
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
    expect(screen.getByRole("tablist", { name: "状态分区" })).toBeVisible();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("tab", { name: /连接/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /传感器/ })).toBeVisible();

    expect(screen.getByLabelText("SSH / 隧道")).toBeVisible();
    expect(screen.getByLabelText("Bridge")).toBeVisible();
    expect(screen.getByLabelText("micro-ROS Agent")).toBeVisible();
    expect(screen.getByLabelText("Hardware")).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: /硬件健康/ }));
    expect(screen.getByLabelText("Hardware")).toBeVisible();
    expect(screen.getByLabelText("ROS 就绪")).toBeVisible();
    expect(screen.getByLabelText("ros2_control")).toBeVisible();
    expect(screen.getByLabelText("USB CDC / ACM")).toBeVisible();
    expect(screen.queryByLabelText("DDS Domain")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("systemd")).not.toBeInTheDocument();

    expect(screen.getByTestId("status-sticky-alert")).toHaveTextContent(/无重力补偿/);
    expect(screen.getByTestId("status-sticky-alert")).toHaveAttribute("data-kind", "hold");
    expect(screen.getByText("42")).toBeVisible();
    expect(screen.getByText("localhost:18765")).not.toBeVisible();
    expect(screen.getByTestId("status-detail-hardware")).toHaveTextContent(/无重力补偿/);
    await user.click(screen.getByRole("tab", { name: /控制模式/ }));
    expect(screen.getByTestId("status-mode-idle")).toBeVisible();
    expect(screen.queryByLabelText("Teleop")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Teleop" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Trajectory" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "VLA" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "回零并退出控制" })).toBeEnabled();
    await user.click(screen.getByText("直接关闭输出…"));
    expect(screen.getByRole("button", { name: "直接解除电机输出" })).toBeEnabled();


    await user.click(screen.getByRole("button", { name: "Teleop" }));
    expect(onQuickAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "启动所选模式" }));
    expect(onQuickAction).toHaveBeenCalledWith("teleop");
    await user.click(screen.getByRole("button", { name: "VLA" }));
    await user.click(screen.getByRole("button", { name: "启动所选模式" }));
    expect(onQuickAction).toHaveBeenCalledWith("vla");
    await user.click(screen.getByRole("button", { name: "直接解除电机输出" }));
    expect(screen.getByRole("dialog", { name: "解除电机输出确认" })).toBeVisible();
    expect(screen.getByRole("button", { name: "确认 DISABLE 并停止" })).toBeDisabled();
    expect(onQuickAction).not.toHaveBeenCalledWith("disable-stop");
    await user.click(screen.getByRole("checkbox", { name: "机械臂已支撑，可以解除输出" }));
    await user.click(screen.getByRole("button", { name: "确认 DISABLE 并停止" }));
    expect(onQuickAction).toHaveBeenCalledWith("disable-stop");
    expect(screen.queryByRole("dialog", { name: "解除电机输出确认" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /硬件健康/ }));
    await user.click(screen.getByRole("button", { name: "刷新检测" }));
    expect(onCardAction).toHaveBeenCalled();
    expect(onCardAction.mock.calls[0][0].id).toBe("usb-refresh");
  });

  it("shows only the active mode detail and marks the strip segment pressed", async () => {
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
        rosControl={{
          manager: "/controller_manager",
          available: true,
          controllers: [
            { name: "arm_teleop_controller", typeName: "t", state: "active" },
            { name: "gravity_compensation_controller", typeName: "t", state: "active" },
          ],
          message: "",
        }}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /控制模式/ }));
    expect(screen.queryByTestId("status-sticky-alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Teleop")).toBeVisible();
    expect(screen.queryByLabelText("Trajectory / MoveIt")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("VLA")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Teleop" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("arm_teleop_controller")).toBeVisible();
    expect(screen.getByText(/Gravity/)).toBeVisible();
    // Mode cards no longer expose primary restart; Agent/RealSense may still offer 重新拉起.
    expect(screen.queryByLabelText("Teleop 操作")).not.toBeInTheDocument();
  });

  it("prefers list_controllers over teleopRunning for strip selection after switch_controllers", async () => {
    render(
      <StatusPage
        {...baseProps}
        armMode={{
          ...baseProps.armMode,
          mode: "teleop",
          teleopRunning: true,
          teleopPid: 99,
        }}
        rosControl={{
          manager: "/controller_manager",
          available: true,
          controllers: [
            { name: "arm_teleop_controller", typeName: "t", state: "inactive" },
            { name: "arm_trajectory_controller", typeName: "t", state: "active" },
            { name: "gravity_compensation_controller", typeName: "t", state: "active" },
          ],
          message: "",
        }}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /控制模式/ }));
    expect(screen.getByRole("button", { name: "Trajectory" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Teleop" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Trajectory / MoveIt")).toBeVisible();
    expect(screen.getByText("arm_trajectory_controller")).toBeVisible();
  });

  it("surfaces disabledReasons as on-page hints for gated quick actions", async () => {
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
    await userEvent.click(screen.getByRole("tab", { name: /控制模式/ }));
    expect(screen.getByRole("button", { name: "Teleop" })).toBeDisabled();
    expect(screen.getByTestId("status-mode-disabled")).toHaveTextContent("SSH 未就绪");
    await userEvent.click(screen.getByRole("tab", { name: /硬件健康/ }));
    expect(screen.getByTestId("status-disabled-usb-usb-refresh")).toHaveTextContent("SSH 未就绪");
  });
});


describe("Status tab navigation", () => {
  it("updates an unselected hardware tab to red and follows a fault highlight request", async () => {
    const { rerender } = render(<StatusPage {...baseProps} />);
    expect(screen.getByRole("tab", { name: /连接/ })).toHaveAttribute("aria-selected", "true");
    rerender(<StatusPage {...baseProps} hardwareStatus={{ fault_code: 11, mode: 0 }} />);
    expect(screen.getByRole("tab", { name: /硬件健康/ })).toHaveClass("tone-fail");
    expect(screen.getByRole("tab", { name: /连接/ })).toHaveAttribute("aria-selected", "true");
    rerender(<StatusPage {...baseProps} highlightCardId="hardware" />);
    expect(screen.getByRole("tab", { name: /硬件健康/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("article", { name: "Hardware" })).toHaveAttribute("data-highlighted", "true");
  });
  it("supports arrow keys, Home/End and shows one panel at a time", async () => {
    const user = userEvent.setup();
    render(<StatusPage {...baseProps} />);
    screen.getByRole("tab", { name: /连接/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: /硬件健康/ })).toHaveFocus();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /传感器/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: /连接/ })).toHaveFocus();
  });
});


it("separates current mode from target selection and waits for explicit switch", async () => {
  const user = userEvent.setup(); const action = vi.fn();
  render(<StatusPage {...baseProps} onQuickAction={action} rosControl={{ ...baseProps.rosControl,
    controllers: [{name: "arm_trajectory_controller", typeName: "t", state: "active"}] }} />);
  await user.click(screen.getByRole("tab", {name: /控制模式/}));
  expect(screen.getByTestId("current-control-mode")).toHaveTextContent("Trajectory");
  expect(screen.getByRole("button", {name: "当前模式已启用"})).toBeDisabled();
  await user.click(screen.getByRole("button", {name: "Teleop"}));
  expect(action).not.toHaveBeenCalled();
  expect(screen.getByTestId("current-control-mode")).toHaveTextContent("Trajectory");
  await user.click(screen.getByRole("button", {name: "切换模式（先回零）"}));
  expect(action).toHaveBeenCalledTimes(1); expect(action).toHaveBeenCalledWith("teleop");
  expect(screen.getByText(/不是暂停或保持/)).toBeVisible();
});

it("shows one busy notice and disables conflicting mode and stop operations", async () => {
  const user = userEvent.setup();
  render(<StatusPage {...baseProps} actionBusy="trajectory-restart" />);
  await user.click(screen.getByRole("tab", {name: /控制模式/}));
  expect(screen.getByRole("button", {name: "Trajectory"})).toHaveTextContent("Trajectory");
  expect(screen.getByRole("button", {name: "切换中…"})).toBeDisabled();
  expect(screen.getByRole("button", {name: "回零并退出控制"})).toBeDisabled();
  expect(screen.getAllByText("操作进行中")).toHaveLength(1);
});

it("offers explicit same-mode session rebuild after firmware DISABLE without automatic restart", async () => {
  const user = userEvent.setup(); const action = vi.fn();
  const controllers = { ...baseProps.rosControl,
    controllers: [{ name: "arm_trajectory_controller", typeName: "t", state: "active" }] };
  const props = { ...baseProps, onQuickAction: action, rosControl: controllers };
  const { rerender } = render(<StatusPage {...props} />);
  await user.click(screen.getByRole("tab", { name: /控制模式/ }));
  expect(screen.getByRole("button", { name: "当前模式已启用" })).toBeDisabled();
  rerender(<StatusPage {...props} hardwareStatus={{ mode: 3, mode_name: "DISABLE", fault_code: 0, last_command_sequence: 0 }} />);
  expect(screen.getByTestId("current-control-mode")).toHaveTextContent("Trajectory（输出已关闭）");
  expect(screen.getByText("下位机输出已关闭，旧控制会话需要重建")).toBeVisible();
  expect(action).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "重建控制会话" }));
  expect(action).toHaveBeenCalledExactlyOnceWith("trajectory");
  rerender(<StatusPage {...props} actionBusy="trajectory-restart" hardwareStatus={{ mode: 3, fault_code: 0 }} />);
  expect(screen.getByRole("button", { name: "切换中…" })).toBeDisabled();
  rerender(<StatusPage {...props} hardwareStatus={{ mode: 3, fault_code: 11 }} />);
  expect(screen.getByRole("button", { name: "重建控制会话" })).toBeDisabled();
});

it("shows RETURN as an unfinished stop and blocks starting either selected mode", async () => {
  const user = userEvent.setup(); const action = vi.fn();
  render(<StatusPage {...baseProps} hardwareStatus={{mode: 2, fault_code: 0}} onQuickAction={action}
    rosControl={{...baseProps.rosControl, controllers: [{name: "arm_trajectory_controller", typeName: "t", state: "active"}]}} />);
  await user.click(screen.getByRole("tab", {name: /控制模式/}));
  expect(screen.getByTestId("current-control-mode")).toHaveTextContent("Trajectory（回零中）");
  expect(screen.getByRole("button", {name: "等待回零完成"})).toBeDisabled();
  await user.click(screen.getByRole("button", {name: "Teleop"}));
  expect(screen.getByRole("button", {name: "等待回零完成"})).toBeDisabled();
  expect(action).not.toHaveBeenCalled();
});

it("follows the starting controller and resets manual log selection when the controller changes", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<StatusPage {...baseProps} />);
  await user.click(screen.getByRole("tab", {name: /控制模式/}));
  await user.selectOptions(screen.getByRole("combobox", {name: "日志来源"}), "realsense");
  rerender(<StatusPage {...baseProps} workflow={{mode: "trajectory", stage: "startup", message: "starting", failed: false, running: true}} />);
  expect(screen.getByRole("combobox", {name: "日志来源"})).toHaveValue("auto");
  expect(screen.getByRole("option", {name: "当前模式（Trajectory）"})).toBeInTheDocument();
  expect(screen.getByRole("checkbox", {name: "跟随最新"})).toBeChecked();
});

it("keeps the last target/log after verified stop and treats manager shutdown as expected", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<StatusPage {...baseProps} rosControl={{...baseProps.rosControl,
    controllers: [{name: "arm_trajectory_controller", typeName: "t", state: "active"}]}} />);
  await user.click(screen.getByRole("tab", {name: /控制模式/}));
  rerender(<StatusPage {...baseProps} hardwareStatus={{mode: 3, fault_code: 0}} rosControl={{...baseProps.rosControl, available: false, controllers: []}}
    armMode={{...baseProps.armMode, teleopRunning: true}} workflow={{mode: "stop", stage: "ready", message: "stopped", failed: false, running: false}} />);
  expect(screen.getByTestId("current-control-mode")).toHaveTextContent("未启用控制");
  expect(screen.getByRole("button", {name: "Trajectory"})).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("option", {name: "当前模式（Trajectory）"})).toBeInTheDocument();
  expect(screen.getByRole("tab", {name: /控制模式/})).not.toHaveTextContent("异常");
  await user.click(screen.getByRole("tab", {name: /硬件健康/}));
  expect(screen.getByText("控制环境已退出（预期）")).toBeVisible();
});
