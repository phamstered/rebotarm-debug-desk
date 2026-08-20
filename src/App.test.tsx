import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  invoke: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  listTopics: vi.fn().mockResolvedValue([
    { name: "/robot_description", types: ["std_msgs/msg/String"] },
    { name: "/stm32/status", types: ["microros_stm32h723_bridge/msg/HardwareStatus"] },
  ]),
  send: vi.fn(),
  request: vi.fn().mockResolvedValue({ op: "joint_command_ack", sequence: 1 }),
  close: vi.fn(),
  listener: undefined as ((message: unknown) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
vi.mock("./bridge", () => ({
  BridgeClient: class {
    connect = doubles.connect;
    listTopics = doubles.listTopics;
    send = doubles.send;
    request = doubles.request;
    close = doubles.close;
    onMessage(listener: (message: unknown) => void) { doubles.listener = listener; return () => {}; }
  },
}));
vi.mock("./UrdfViewer", () => ({ UrdfViewer: ({ xml }: { xml: string }) => <div data-testid="urdf">{xml || "empty"}</div> }));
vi.mock("./MotorControl", () => ({ MotorControl: () => <div data-testid="motor">motor</div> }));

import App from "./App";

describe("App workflow", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });
      if (command === "check_ros_controllers") return Promise.resolve({
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "joint_state_broadcaster", typeName: "joint_state_broadcaster/JointStateBroadcaster", state: "active" },
          { name: "arm_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "inactive" },
        ],
        message: "",
      });
      if (command === "start_session") return Promise.resolve(19001);
      return Promise.resolve(undefined);
    });
  });

  it("migrates the legacy topic, connects, discovers and subscribes topics", async () => {
    localStorage.setItem("easy-debug-profile", JSON.stringify({ jointStateTopic: "/joint_states", host: "damiao" }));
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByLabelText("JointState Topic")).toHaveValue("/stm32/joint_states");
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    expect(await screen.findByText("micro-ROS Agent：运行中")).toBeVisible();
    expect(screen.getByText("localhost:19001")).toBeVisible();
    expect(screen.getByText("Robot Console")).toBeVisible();
    expect(screen.getByRole("button", { name: /\/robot_description/ })).toBeVisible();
    expect(doubles.connect).toHaveBeenCalledWith(expect.objectContaining({ localPort: 19001, jointStateTopic: "/stm32/joint_states" }));
    expect(doubles.send).toHaveBeenCalledWith({ op: "subscribe", topic: "/stm32/joint_states", type: "sensor_msgs/msg/JointState" });
  });

  it("shows loaded ROS Control controllers and their current states below Topics", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const control = await screen.findByRole("region", { name: "ROS Control Controllers" });
    expect(control).toHaveTextContent("/controller_manager");
    expect(control).toHaveTextContent("joint_state_broadcaster");
    expect(control).toHaveTextContent("active");
    expect(control).toHaveTextContent("arm_controller");
    expect(control).toHaveTextContent("inactive");
    expect(doubles.invoke).toHaveBeenCalledWith("check_ros_controllers", expect.objectContaining({ profile: expect.any(Object) }));
  });

  it("manually refreshes Topics and ROS Control while scheduling both every five seconds", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
      await screen.findByText("joint_state_broadcaster");

      const topicCalls = doubles.listTopics.mock.calls.length;
      const controllerCalls = doubles.invoke.mock.calls.filter(([command]) => command === "check_ros_controllers").length;
      const refreshTopics = screen.getByRole("button", { name: "刷新Topics" });
      const refreshControllers = screen.getByRole("button", { name: "刷新ROS Control" });
      expect(refreshTopics).toBeEnabled();
      expect(refreshControllers).toBeEnabled();

      await user.click(refreshTopics);
      await user.click(refreshControllers);
      await waitFor(() => expect(doubles.listTopics).toHaveBeenCalledTimes(topicCalls + 1));
      await waitFor(() => expect(
        doubles.invoke.mock.calls.filter(([command]) => command === "check_ros_controllers"),
      ).toHaveLength(controllerCalls + 1));
      expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 5000).length).toBeGreaterThanOrEqual(3);
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("shows ROS Control as offline without blocking the connected workspace", async () => {
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });
      if (command === "check_ros_controllers") return Promise.resolve({
        manager: "/controller_manager", available: false, controllers: [],
        message: "controller_manager 服务不可用或查询超时",
      });
      if (command === "start_session") return Promise.resolve(19001);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const control = await screen.findByRole("region", { name: "ROS Control Controllers" });
    expect(control).toHaveTextContent("离线");
    expect(control).toHaveTextContent("controller_manager 服务不可用或查询超时");
    expect(screen.getByText("Robot View")).toBeVisible();
  });

  it("selects a topic and independently collapses all four data panels", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");
    await user.click(screen.getByRole("button", { name: /\/stm32\/status/ }));
    expect(doubles.send).toHaveBeenCalledWith(expect.objectContaining({ op: "subscribe", topic: "/stm32/status" }));

    await user.click(screen.getByRole("button", { name: "收起Topics" }));
    expect(container.querySelector(".topics-section")).toHaveClass("collapsed");
    expect(container.querySelector(".ros-control-panel")).toHaveClass("expanded");
    expect(screen.getByRole("button", { name: "展开Topics" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "收起ROS Control" }));
    await user.click(screen.getByRole("button", { name: "收起Motor Control" }));
    await user.click(screen.getByRole("button", { name: "收起Topic Inspector" }));
    expect(container.querySelector(".ros-control-panel")).toHaveClass("collapsed");
    expect(container.querySelector(".motor-section")).toHaveClass("collapsed");
    expect(container.querySelector(".inspector-section")).toHaveClass("collapsed");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("easy-debug-panels")!)).toEqual({ topics: false, rosControl: false, motor: false, inspector: false }));
  });

  it("resizes all four panel groups with accessible splitters and persists the layout", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");

    const leftColumn = screen.getByRole("separator", { name: "调整 Topics 侧栏宽度" });
    const rightColumn = screen.getByRole("separator", { name: "调整数据侧栏宽度" });
    const leftRows = screen.getByRole("separator", { name: "调整 Topics 和 ROS Control 高度" });
    const rightRows = screen.getByRole("separator", { name: "调整 Motor Control 和 Topic Inspector 高度" });

    leftColumn.focus();
    await user.keyboard("{ArrowRight}");
    rightColumn.focus();
    await user.keyboard("{ArrowLeft}");
    leftRows.focus();
    await user.keyboard("{ArrowDown}");
    rightRows.focus();
    await user.keyboard("{ArrowUp}");

    const workspace = container.querySelector<HTMLElement>(".workspace")!;
    expect(workspace.style.getPropertyValue("--left-width")).toBe("282px");
    expect(workspace.style.getPropertyValue("--right-width")).toBe("342px");
    expect(workspace.style.getPropertyValue("--left-top-size")).toBe("67%");
    expect(workspace.style.getPropertyValue("--right-top-size")).toBe("53%");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("easy-debug-layout")!)).toMatchObject({
      leftWidth: 282,
      rightWidth: 342,
      leftTopRatio: 0.67,
      rightTopRatio: 0.53,
    }));
  });

  it("routes URDF, joint state and hardware status messages", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");
    doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "<robot/>" });
    await waitFor(() => expect(screen.getByTestId("urdf")).toHaveTextContent("<robot/>"));
  });
});
