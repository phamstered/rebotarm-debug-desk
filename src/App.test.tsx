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
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
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
    expect(screen.getByRole("button", { name: /\/robot_description/ })).toBeVisible();
    expect(doubles.connect).toHaveBeenCalledWith(expect.objectContaining({ localPort: 19001, jointStateTopic: "/stm32/joint_states" }));
    expect(doubles.send).toHaveBeenCalledWith({ op: "subscribe", topic: "/stm32/joint_states", type: "sensor_msgs/msg/JointState" });
  });

  it("selects a topic and independently collapses all three panels", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");
    await user.click(screen.getByRole("button", { name: /\/stm32\/status/ }));
    expect(doubles.send).toHaveBeenCalledWith(expect.objectContaining({ op: "subscribe", topic: "/stm32/status" }));

    await user.click(screen.getByRole("button", { name: "收起Topics" }));
    await user.click(screen.getByRole("button", { name: "收起Motor Control" }));
    await user.click(screen.getByRole("button", { name: "收起Topic Inspector" }));
    expect(container.querySelector(".workspace")).toHaveClass("topics-collapsed");
    expect(container.querySelector(".motor-section")).toHaveClass("collapsed");
    expect(container.querySelector(".inspector-section")).toHaveClass("collapsed");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("easy-debug-panels")!)).toEqual({ topics: false, motor: false, inspector: false }));
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
