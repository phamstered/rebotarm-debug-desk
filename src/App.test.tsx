import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  connect: vi.fn().mockResolvedValue({
    bridge_version: "0.1.0",
    bridge_build_id: "dc8f3b4c126c",
    ros_distro: "humble",
  }),
  listTopics: vi.fn().mockResolvedValue([
    { name: "/robot_description", types: ["std_msgs/msg/String"] },
    { name: "/stm32/status", types: ["microros_stm32h723_bridge/msg/HardwareStatus"] },
    { name: "/stm32/joint_states", types: ["sensor_msgs/msg/JointState"] },
  ]),
  getGraph: vi.fn().mockResolvedValue({
    nodes: [
      { id: "node:/hardware_driver", label: "/hardware_driver", kind: "node", types: [] },
      { id: "topic:/stm32/status", label: "/stm32/status", kind: "topic", types: ["microros_stm32h723_bridge/msg/HardwareStatus"] },
    ],
    edges: [{ source: "node:/hardware_driver", target: "topic:/stm32/status", relation: "publish" }],
  }),
  getTopicInfo: vi.fn().mockResolvedValue({ name: "/stm32/status", types: ["microros_stm32h723_bridge/msg/HardwareStatus"], publishers: [], subscriptions: [] }),
  getNodeInfo: vi.fn().mockImplementation((node: string) => Promise.resolve({ name: node, namespace: "/", publishers: [], subscriptions: [], services: [], clients: [] })),
  send: vi.fn(),
  request: vi.fn().mockResolvedValue({ op: "joint_command_ack", sequence: 1 }),
  close: vi.fn(),
  listener: undefined as ((message: unknown) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: doubles.save }));
vi.mock("./bridge", () => ({
  BridgeClient: class {
    connect = doubles.connect;
    listTopics = doubles.listTopics;
    getGraph = doubles.getGraph;
    getTopicInfo = doubles.getTopicInfo;
    getNodeInfo = doubles.getNodeInfo;
    send = doubles.send;
    request = doubles.request;
    close = doubles.close;
    onMessage(listener: (message: unknown) => void) { doubles.listener = listener; return () => {}; }
  },
}));
vi.mock("./UrdfViewer", () => ({
  UrdfViewer: ({ xml, trajectoryController, onSendTrajectory }: {
    xml: string;
    trajectoryController: { name: string; topic: string } | null;
    onSendTrajectory(request: { jointNames: string[]; points: { positions: number[]; time_from_start: number }[] }): Promise<void>;
  }) => (
    <div data-testid="urdf">
      <span>{xml || "empty"}</span>
      <span data-testid="trajectory-controller">{trajectoryController ? `${trajectoryController.name}@${trajectoryController.topic}` : "none"}</span>
      <button
        type="button"
        data-testid="send-trajectory"
        onClick={() => {
          void onSendTrajectory({
            jointNames: ["joint1", "joint2"],
            points: [
              { positions: [0, 0], time_from_start: 0.1 },
              { positions: [0.5, -0.2], time_from_start: 1.2 },
            ],
          }).catch((reason: unknown) => {
            const node = document.querySelector<HTMLElement>("[data-testid='trajectory-error']");
            if (node) node.textContent = `failed: ${reason instanceof Error ? reason.message : String(reason)}`;
          });
        }}
      >
        下发轨迹
      </button>
      <output data-testid="trajectory-error" />
    </div>
  ),
}));
vi.mock("./MotorControl", () => ({ MotorControl: () => <div data-testid="motor">motor</div> }));

import App from "./App";

describe("App workflow", () => {
  function emitRosReady() {
    act(() => {
      doubles.listener?.({
        op: "topic_message",
        topic: "/stm32/joint_states",
        data: { name: ["j1"], position: [0.1] },
      });
    });
  }

  beforeEach(() => {
    localStorage.clear();
    // Keep legacy workflow tests on Topics after connect; dedicated cases cover Status default.
    localStorage.setItem("easy-debug-navigate-status-on-connect", "false");
    vi.clearAllMocks();
    doubles.save.mockResolvedValue("/tmp/robot-console-diagnostics.json");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    doubles.invoke.mockImplementation((command: string, args?: { controllerName?: string; action?: string; bagPath?: string }) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "data_collection_action") return Promise.resolve({
        state: "stopped", managed: false, pid: 0, recording: false, pendingFrames: 0, savedEpisodes: 0,
        fps: 0, task: "", repoId: "", root: "", message: "", log: "",
      });
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });

      if (command === "probe_jetson_usb") return Promise.resolve({
        mcuPresent: true, mcuVidPid: "0483:5740", serialPath: "/dev/ttyACM0",
        realsensePresent: false, realsenseLines: [], rawLsusb: "0483:5740",
      });
      if (command === "probe_arm_mode") return Promise.resolve({
        mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false,
        teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "idle",
      });
      if (command === "restart_micro_ros_agent") return Promise.resolve({ ok: true, exitCode: 0, message: "micro-ROS Agent 已重启", detail: "" });
      if (command === "start_arm_mode") return Promise.resolve({ ok: true, exitCode: 0, message: "arm mode started", detail: "" });
      if (command === "check_ros_controllers") return Promise.resolve({
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "joint_state_broadcaster", typeName: "joint_state_broadcaster/JointStateBroadcaster", state: "active" },
          { name: "arm_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "inactive" },
        ],
        message: "",
      });
      if (command === "switch_ros_controller") return Promise.resolve(
        `${args?.controllerName} ${args?.action} complete`,
      );
      if (command === "read_control_log") return Promise.resolve({ source: "teleop", path: "", exists: false, content: "", truncated: false, sizeBytes: 0, revision: "" });
      if (command === "get_rosbag_status") return Promise.resolve({ recording: false, pid: 0, outputPath: "", message: "rosbag 当前未录制" });
      if (command === "start_rosbag_recording") return Promise.resolve({ recording: true, pid: 42, outputPath: "/home/robot/robot-console-bags/run", message: "rosbag 录制已开始" });
      if (command === "stop_rosbag_recording") return Promise.resolve({ recording: false, pid: 0, outputPath: "/home/robot/robot-console-bags/run", message: "rosbag 录制已停止" });
      if (command === "get_rosbag_play_status") return Promise.resolve({ playing: false, pid: 0, bagPath: "", message: "rosbag 当前未回放" });
      if (command === "start_rosbag_playback") return Promise.resolve({ playing: true, pid: 9, bagPath: args?.bagPath || "", message: "rosbag 回放已开始" });
      if (command === "stop_rosbag_playback") return Promise.resolve({ playing: false, pid: 0, bagPath: "robot-console-bags/demo", message: "rosbag 回放已停止" });
      if (command === "start_session") return Promise.resolve(19001);
      return Promise.resolve(undefined);
    });
  });

  it("opens data collection from Navigation before ROS feedback is ready", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "数据采集" }));
    expect(screen.getByRole("region", { name: "数据采集" })).toBeVisible();
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("data_collection_action", expect.objectContaining({ action: "status", config: null })));
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
  });

  it("migrates the legacy topic, connects, discovers and subscribes topics", async () => {
    localStorage.setItem("easy-debug-profile", JSON.stringify({ jointStateTopic: "/joint_states", host: "robot-host" }));
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByLabelText("SSH 主机")).toHaveValue("robot-host");
    expect(screen.queryByLabelText("JointState Topic")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("URDF Topic")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("配置名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("TCP Link")).not.toBeInTheDocument();
    const advanced = screen.getByText("高级").closest("details");
    expect(advanced).toBeTruthy();
    expect(advanced).not.toHaveAttribute("open");
    await user.click(screen.getByText("高级"));
    expect(advanced).toHaveAttribute("open");
    expect(screen.getByLabelText("ROS_DOMAIN_ID")).toBeVisible();
    expect(screen.getByLabelText("ROS 环境脚本")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    expect(await screen.findByText("micro-ROS Agent：运行中")).toBeVisible();
    expect(screen.getByText("localhost:19001")).toBeVisible();
    expect(screen.getByRole("toolbar", { name: "应用工具栏" })).toBeVisible();
    expect(screen.getByRole("button", { name: /\/robot_description/ })).toBeVisible();
    expect(doubles.connect).toHaveBeenCalledWith(expect.objectContaining({ localPort: 19001, jointStateTopic: "/stm32/joint_states" }));
    expect(doubles.send).toHaveBeenCalledWith({ op: "subscribe", topic: "/stm32/joint_states", type: "sensor_msgs/msg/JointState" });
  });


  it("prompts to upgrade when Bridge build id mismatches", async () => {
    doubles.connect.mockResolvedValueOnce({
      bridge_version: "0.1.0",
      bridge_build_id: "deadbeef0001",
      ros_distro: "humble",
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const dialog = await screen.findByRole("dialog", { name: "Bridge 版本不匹配" });
    expect(dialog).toHaveTextContent("deadbeef0001");
    expect(within(dialog).getByRole("button", { name: "升级" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "跳过" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "跳过" }));
    expect(screen.queryByRole("dialog", { name: "Bridge 版本不匹配" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/已跳过 Bridge 升级/).length).toBeGreaterThan(0);
  });

  it("runs deploy_bridge when upgrade is confirmed", async () => {
    doubles.connect
      .mockResolvedValueOnce({
        bridge_version: "0.1.0",
        bridge_build_id: "oldbuild00001",
        ros_distro: "humble",
      })
      .mockResolvedValueOnce({
        bridge_version: "0.1.0",
        bridge_build_id: "dc8f3b4c126c",
        ros_distro: "humble",
      });
    doubles.invoke.mockImplementation((command: string, args?: { controllerName?: string; action?: string; bagPath?: string }) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });

      if (command === "probe_jetson_usb") return Promise.resolve({
        mcuPresent: true, mcuVidPid: "0483:5740", serialPath: "/dev/ttyACM0",
        realsensePresent: false, realsenseLines: [], rawLsusb: "0483:5740",
      });
      if (command === "probe_arm_mode") return Promise.resolve({
        mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false,
        teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "idle",
      });
      if (command === "restart_micro_ros_agent") return Promise.resolve({ ok: true, exitCode: 0, message: "micro-ROS Agent 已重启", detail: "" });
      if (command === "start_arm_mode") return Promise.resolve({ ok: true, exitCode: 0, message: "arm mode started", detail: "" });
      if (command === "check_ros_controllers") return Promise.resolve({
        manager: "/controller_manager", available: true, controllers: [], message: "",
      });
      if (command === "get_rosbag_status") return Promise.resolve({ recording: false, pid: 0, outputPath: "", message: "rosbag 当前未录制" });
      if (command === "get_rosbag_play_status") return Promise.resolve({ playing: false, pid: 0, bagPath: "", message: "rosbag 当前未回放" });
      if (command === "start_session") return Promise.resolve(19001);
      if (command === "deploy_bridge") return Promise.resolve({ ok: true, message: "Bridge 已同步、编译并重启", log: "[done]" });
      if (command === "stop_session") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const dialog = await screen.findByRole("dialog", { name: "Bridge 版本不匹配" });
    await user.click(within(dialog).getByRole("button", { name: "升级" }));
    await waitFor(() => {
      expect(doubles.invoke).toHaveBeenCalledWith("deploy_bridge", expect.objectContaining({ profile: expect.any(Object) }));
    });
    await screen.findByRole("toolbar", { name: "应用工具栏" });
    expect(screen.queryByRole("dialog", { name: "Bridge 版本不匹配" })).not.toBeInTheDocument();
  });

  it("warns without forcing upgrade when hello lacks build id", async () => {
    doubles.connect.mockResolvedValueOnce({
      bridge_version: "0.1.0",
      ros_distro: "humble",
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });
    expect(screen.queryByRole("dialog", { name: "Bridge 版本不匹配" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/无法确认版本/).length).toBeGreaterThan(0);
  });
  it("clears all previous connection data before reconnecting", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });
    await user.click(screen.getByRole("button", { name: /\/stm32\/status/ }));
    act(() => {
      doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "old-session-urdf" });
      doubles.listener?.({ op: "topic_message", topic: "/stm32/status", data: { fault_code: 4 } });
    });
    await user.click(screen.getByRole("tab", { name: "Robot View" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("old-session-urdf");
    expect(screen.getByLabelText("Topic JSON")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "断开" }));
    await screen.findByRole("button", { name: "连接 Jetson" });
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });

    await user.click(screen.getByRole("tab", { name: "Robot View" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("empty");
    expect(screen.getByText("从左侧或 Topic Graph 选择一个 Topic")).toBeVisible();
    expect(screen.queryByLabelText("Topic JSON")).not.toBeInTheDocument();
  });

  it("does not let a delayed controller response from the old session repopulate state", async () => {
    let resolveOldControllers!: (value: unknown) => void;
    let controllerRequest = 0;
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });
      if (command === "start_session") return Promise.resolve(19001);

      if (command === "probe_jetson_usb") return Promise.resolve({
        mcuPresent: true, mcuVidPid: "0483:5740", serialPath: "/dev/ttyACM0",
        realsensePresent: false, realsenseLines: [], rawLsusb: "0483:5740",
      });
      if (command === "probe_arm_mode") return Promise.resolve({
        mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false,
        teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "idle",
      });
      if (command === "restart_micro_ros_agent") return Promise.resolve({ ok: true, exitCode: 0, message: "micro-ROS Agent 已重启", detail: "" });
      if (command === "start_arm_mode") return Promise.resolve({ ok: true, exitCode: 0, message: "arm mode started", detail: "" });
      if (command === "check_ros_controllers") {
        controllerRequest += 1;
        if (controllerRequest === 1) {
          return new Promise((resolve) => { resolveOldControllers = resolve; });
        }
        return Promise.resolve({
          manager: "/controller_manager", available: true,
          controllers: [{ name: "new_controller", typeName: "test/New", state: "active" }], message: "",
        });
      }
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("button", { name: "断开" });
    await user.click(screen.getByRole("button", { name: "断开" }));
    await user.click(await screen.findByRole("button", { name: "连接 Jetson" }));
    expect(await screen.findByText("new_controller")).toBeVisible();

    await act(async () => {
      resolveOldControllers({
        manager: "/controller_manager", available: true,
        controllers: [{ name: "old_controller", typeName: "test/Old", state: "active" }], message: "",
      });
      await Promise.resolve();
    });

    expect(screen.getByText("new_controller")).toBeVisible();
    expect(screen.queryByText("old_controller")).not.toBeInTheDocument();
  });

  it("filters Topics by name or message type without changing subscriptions", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const filter = await screen.findByRole("searchbox", { name: "过滤 Topics" });
    const sendsBeforeFilter = doubles.send.mock.calls.length;

    await user.type(filter, "STATUS");
    expect(screen.getByRole("button", { name: /\/stm32\/status/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /\/robot_description/ })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "std_msgs");
    expect(screen.getByRole("button", { name: /\/robot_description/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /\/stm32\/status/ })).not.toBeInTheDocument();
    expect(doubles.send).toHaveBeenCalledTimes(sendsBeforeFilter);
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

  it("collapses and restores both outer sidebars", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("button", { name: "收起左侧栏" });
    await user.click(screen.getByRole("button", { name: "收起左侧栏" }));
    await user.click(screen.getByRole("button", { name: "收起右侧栏" }));
    expect(container.querySelector(".topic-sidebar")).toHaveClass("sidebar-collapsed");
    expect(container.querySelector(".data-panel")).toHaveClass("sidebar-collapsed");
    expect(container.querySelector<HTMLElement>(".workspace")?.style.getPropertyValue("--left-width")).toBe("30px");
    await user.click(screen.getByRole("button", { name: "展开左侧栏" }));
    await user.click(screen.getByRole("button", { name: "展开右侧栏" }));
    expect(JSON.parse(localStorage.getItem("easy-debug-sidebars")!)).toEqual({ left: true, right: true });
  });

  it("opens Topic Graph when focusing a ROS Controller", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "在 Topic Graph 聚焦 Controller arm_controller" }));
    expect(screen.getByRole("tab", { name: "Topic Graph" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
  });

  it("activates and deactivates controllers and refreshes the list after each operation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("joint_state_broadcaster");

    const controllerQueries = () => doubles.invoke.mock.calls
      .filter(([command]) => command === "check_ros_controllers").length;
    const beforeDeactivate = controllerQueries();
    await user.click(screen.getByRole("button", { name: "停用 Controller joint_state_broadcaster" }));
    expect(doubles.invoke).toHaveBeenCalledWith("switch_ros_controller", {
      profile: expect.any(Object),
      controllerName: "joint_state_broadcaster",
      action: "deactivate",
    });
    await waitFor(() => expect(controllerQueries()).toBe(beforeDeactivate + 1));
    expect(screen.getByText("joint_state_broadcaster deactivate complete")).toBeVisible();

    const beforeActivate = controllerQueries();
    await user.click(screen.getByRole("button", { name: "激活 Controller arm_controller" }));
    expect(doubles.invoke).toHaveBeenCalledWith("switch_ros_controller", {
      profile: expect.any(Object),
      controllerName: "arm_controller",
      action: "activate",
    });
    await waitFor(() => expect(controllerQueries()).toBe(beforeActivate + 1));
    expect(screen.getByText("arm_controller activate complete")).toBeVisible();
  });

  it("manually refreshes Topics and ROS Control and executes both 30-second pollers", async () => {
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

      const automaticRefreshes = intervalSpy.mock.calls
        .filter(([, delay]) => delay === 30_000)
        .map(([callback]) => callback as () => void);
      expect(automaticRefreshes).toHaveLength(2);
      const topicsBeforeAutoRefresh = doubles.listTopics.mock.calls.length;
      const controllersBeforeAutoRefresh = doubles.invoke.mock.calls.filter(([command]) => command === "check_ros_controllers").length;
      await act(async () => {
        automaticRefreshes.forEach((refresh) => refresh());
        await Promise.resolve();
      });
      await waitFor(() => expect(doubles.listTopics).toHaveBeenCalledTimes(topicsBeforeAutoRefresh + 1));
      await waitFor(() => expect(
        doubles.invoke.mock.calls.filter(([command]) => command === "check_ros_controllers"),
      ).toHaveLength(controllersBeforeAutoRefresh + 1));
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

      if (command === "probe_jetson_usb") return Promise.resolve({
        mcuPresent: true, mcuVidPid: "0483:5740", serialPath: "/dev/ttyACM0",
        realsensePresent: false, realsenseLines: [], rawLsusb: "0483:5740",
      });
      if (command === "probe_arm_mode") return Promise.resolve({
        mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false,
        teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "idle",
      });
      if (command === "restart_micro_ros_agent") return Promise.resolve({ ok: true, exitCode: 0, message: "micro-ROS Agent 已重启", detail: "" });
      if (command === "start_arm_mode") return Promise.resolve({ ok: true, exitCode: 0, message: "arm mode started", detail: "" });
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
    expect(screen.getByRole("tab", { name: "Robot View" })).toBeVisible();
  });

  it("selects a topic and independently collapses all three dashboard data panels", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");
    await user.click(screen.getByRole("button", { name: /\/stm32\/status/ }));
    expect(doubles.request).toHaveBeenCalledWith(expect.objectContaining({ op: "subscribe", topic: "/stm32/status" }));

    await user.click(screen.getByRole("button", { name: "收起Topics" }));
    expect(container.querySelector(".topics-section")).toHaveClass("collapsed");
    expect(container.querySelector(".ros-control-panel")).toHaveClass("expanded");
    expect(screen.getByRole("button", { name: "展开Topics" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "收起ROS Control" }));
    await user.click(screen.getByRole("button", { name: "收起Inspector" }));
    expect(container.querySelector(".ros-control-panel")).toHaveClass("collapsed");
    expect(container.querySelector(".inspector-section")).toHaveClass("collapsed");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("easy-debug-panels")!)).toEqual({ topics: false, rosControl: false, inspector: false }));
  });

  it("resizes dashboard columns and the left panel group with accessible splitters", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");

    const leftColumn = screen.getByRole("separator", { name: "调整 Topics 侧栏宽度" });
    const rightColumn = screen.getByRole("separator", { name: "调整数据侧栏宽度" });
    const leftRows = screen.getByRole("separator", { name: "调整 Topics 和 ROS Control 高度" });

    leftColumn.focus();
    await user.keyboard("{ArrowRight}");
    rightColumn.focus();
    await user.keyboard("{ArrowLeft}");
    leftRows.focus();
    await user.keyboard("{ArrowDown}");

    const workspace = container.querySelector<HTMLElement>(".workspace")!;
    expect(workspace.style.getPropertyValue("--left-width")).toBe("282px");
    expect(workspace.style.getPropertyValue("--right-width")).toBe("342px");
    expect(workspace.style.getPropertyValue("--left-top-size")).toBe("67%");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("easy-debug-layout")!)).toMatchObject({
      leftWidth: 282,
      rightWidth: 342,
      leftTopRatio: 0.67,
    }));
  });

  it("keeps the same Robot View element across Graph and main navigation", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const viewer = await screen.findByTestId("urdf");
    await user.click(screen.getByRole("tab", { name: "Topic Graph" }));
    expect(viewer).not.toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Robot View" }));
    expect(screen.getByTestId("urdf")).toBe(viewer);
    await user.click(screen.getByRole("button", { name: "Status" }));
    expect(viewer).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Topics" }));
    expect(screen.getByTestId("urdf")).toBe(viewer);
    expect(viewer).toBeVisible();
  });

  it("leases images only while Inspector data is visible, releases and resubscribes on return", async () => {
    doubles.listTopics.mockResolvedValueOnce([{ name: "/test/image", types: ["sensor_msgs/msg/Image"] }]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: /\/test\/image/ }));
    const subscription = { op: "subscribe", topic: "/test/image", type: "sensor_msgs/msg/Image" };
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith(subscription));
    await user.click(screen.getByRole("tab", { name: "详情" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({ op: "unsubscribe", topic: "/test/image" }));
    doubles.request.mockClear();
    await user.click(screen.getByRole("tab", { name: "数据" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith(subscription));
    await user.click(screen.getByRole("button", { name: "Status" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({ op: "unsubscribe", topic: "/test/image" }));
    // A frame already queued by an older Bridge must not repopulate a hidden preview.
    act(() => doubles.listener?.({ op: "topic_message", topic: "/test/image", data: { encoding: "mono8", width: 1, height: 1, data_bytes: new Uint8Array([1]) } }));
    doubles.request.mockClear();
    await user.click(screen.getByRole("button", { name: "Topics" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith(subscription));
    expect(screen.queryByText(/1 条/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "收起右侧栏" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({ op: "unsubscribe", topic: "/test/image" }));
  });

  it("routes URDF, joint state and hardware status messages", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");
    doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "<robot/>" });
    await waitFor(() => expect(screen.getByTestId("urdf")).toHaveTextContent("<robot/>"));
  });

  it("opens Topic Graph and subscribes a selected topic for inspection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(screen.getByRole("tab", { name: "Topic Graph" }));

    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
    expect(doubles.getGraph).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "Topic /stm32/status" }));
    expect(doubles.request).toHaveBeenCalledWith({
      op: "subscribe",
      topic: "/stm32/status",
      type: "microros_stm32h723_bridge/msg/HardwareStatus",
    });
    expect(screen.getByRole("tab", { name: "数据" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText(/jq 过滤/)).not.toBeInTheDocument();
  });

  it("focuses graph selection from the Topic list and inspects a selected Node", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: /\/stm32\/status/ }));
    expect(screen.getByRole("tab", { name: "Topic Graph" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: "Topic /stm32/status" })).toHaveClass("selected");
    await user.click(screen.getByRole("button", { name: "Node /hardware_driver" }));
    expect(screen.getByRole("tab", { name: "详情" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(doubles.getNodeInfo).toHaveBeenCalledWith("/hardware_driver"));
    expect(screen.getByText("Namespace")).toBeVisible();
  });

  it("inspects a runtime-decoded controller state with nested arrays", async () => {
    doubles.listTopics.mockResolvedValueOnce([
      { name: "/arm/state", types: ["control_msgs/msg/JointTrajectoryControllerState"] },
    ]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: /\/arm\/state/ }));
    expect(doubles.request).toHaveBeenCalledWith({
      op: "subscribe", topic: "/arm/state", type: "control_msgs/msg/JointTrajectoryControllerState",
    });
    act(() => doubles.listener?.({
      op: "topic_message", topic: "/arm/state",
      data: { joint_names: ["joint1"], actual: { positions: [0.25], time_from_start: { sec: 1, nanosec: 0 } } },
    }));
    expect(screen.getByLabelText("Topic JSON")).toBeVisible();
    expect(screen.getByLabelText("Topic JSON").querySelector('[data-monitor-path="actual.positions"]')).toBeInTheDocument();
  });

  it("opens Joint4 Calibration from the collapsible main toolbar", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(screen.getByRole("button", { name: "Joint4 Calibration" }));

    expect(await screen.findByText("多姿态重力与 camera_link 负载标定")).toBeVisible();
    expect(doubles.request).toHaveBeenCalledWith({
      op: "subscribe",
      topic: "/joint4_calibration_controller/status",
      type: "std_msgs/msg/Float64MultiArray",
    });

    await user.click(screen.getByRole("button", { name: "完全收起主工具栏" }));
    await user.click(screen.getByRole("button", { name: "展开主工具栏" }));
    expect(screen.getByRole("navigation", { name: "主工具栏" })).toHaveClass("expanded");
  });

  it("opens Motor from the left navigation and restores Dashboard independently", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("banner", { name: "已连接工具条" });
    emitRosReady();
    expect(await screen.findByText("ROS 就绪")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Motor" }));

    expect(await screen.findByRole("heading", { name: "Motor Control" })).toBeVisible();
    expect(screen.getByTestId("motor")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Robot View" })).not.toBeInTheDocument();
    expect(localStorage.getItem("robot-console-page")).toBe("motor");

    await user.click(screen.getByRole("button", { name: "Topics" }));
    expect(await screen.findByRole("tab", { name: "Robot View" })).toBeVisible();
    expect(screen.queryByTestId("motor")).not.toBeInTheDocument();
  });

  it("refuses to send a trajectory while no trajectory controller is active", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("arm_controller");

    // 默认 mock 中 arm_controller 是 inactive，因此不构成可下发的轨迹控制器。
    expect(screen.getByTestId("trajectory-controller")).toHaveTextContent("none");
    await user.click(screen.getByTestId("send-trajectory"));
    expect(await screen.findByTestId("trajectory-error")).toHaveTextContent("failed: 没有激活的轨迹控制器");
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "trajectory_command" }));
  });

  it("sends a JointTrajectory to the active trajectory controller's topic", async () => {
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });

      if (command === "probe_jetson_usb") return Promise.resolve({
        mcuPresent: true, mcuVidPid: "0483:5740", serialPath: "/dev/ttyACM0",
        realsensePresent: false, realsenseLines: [], rawLsusb: "0483:5740",
      });
      if (command === "probe_arm_mode") return Promise.resolve({
        mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false,
        teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "idle",
      });
      if (command === "restart_micro_ros_agent") return Promise.resolve({ ok: true, exitCode: 0, message: "micro-ROS Agent 已重启", detail: "" });
      if (command === "start_arm_mode") return Promise.resolve({ ok: true, exitCode: 0, message: "arm mode started", detail: "" });
      if (command === "check_ros_controllers") return Promise.resolve({
        manager: "/controller_manager",
        available: true,
        controllers: [
          { name: "joint_state_broadcaster", typeName: "joint_state_broadcaster/JointStateBroadcaster", state: "active" },
          { name: "arm/trajectory_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "active" },
        ],
        message: "",
      });
      if (command === "start_session") return Promise.resolve(19001);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("arm/trajectory_controller");

    expect(screen.getByTestId("trajectory-controller")).toHaveTextContent("arm/trajectory_controller@/arm/trajectory_controller/joint_trajectory");
    await user.click(screen.getByTestId("send-trajectory"));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({
      op: "trajectory_command",
      topic: "/arm/trajectory_controller/joint_trajectory",
      joint_names: ["joint1", "joint2"],
      trajectory_points: [
        { positions: [0, 0], velocities: [], time_from_start: 0.1 },
        { positions: [0.5, -0.2], velocities: [], time_from_start: 1.2 },
      ],
    }, 30_000));
    expect(screen.getByTestId("trajectory-error")).toHaveTextContent("");
  });

  it("marks trajectory controllers in the ROS Control list", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const control = await screen.findByRole("region", { name: "ROS Control Controllers" });
    expect(control).toHaveTextContent("轨迹");
    expect(screen.getByTitle("激活后可在 Robot View 拖拽 TCP 并下发轨迹")).toHaveTextContent("轨迹");
  });

  it("keeps navigation out of the toolbar and restores center view tabs to the panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("joint_state_broadcaster");

    const toolbar = screen.getByRole("toolbar", { name: "应用工具栏" });
    expect(within(toolbar).queryByText("Robot Console")).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "Topics" })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Robot View" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Topic Graph" })).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("tab", { name: "DataGraph" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Monitor" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Robot View" }).closest(".center-tabs")).not.toBeNull();

    const topicCalls = doubles.listTopics.mock.calls.length;
    const controllerCalls = doubles.invoke.mock.calls.filter(([command]) => command === "check_ros_controllers").length;
    await user.click(screen.getByRole("button", { name: "刷新全部状态" }));
    await waitFor(() => expect(doubles.listTopics.mock.calls.length).toBe(topicCalls + 1));
    await waitFor(() => expect(
      doubles.invoke.mock.calls.filter(([command]) => command === "check_ros_controllers").length,
    ).toBe(controllerCalls + 1));

    await user.click(screen.getByRole("tab", { name: "Topic Graph" }));
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Topic Graph" })).toHaveAttribute("aria-selected", "true");
  });

  it("pauses and resumes live topic data without disconnecting", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });
    act(() => doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "first" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("first");

    await user.click(screen.getByRole("button", { name: /暂停显示/ }));
    act(() => doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "paused" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("first");
    expect(screen.getByTestId("urdf")).not.toHaveTextContent("paused");

    await user.click(screen.getByRole("button", { name: /继续显示/ }));
    act(() => doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "resumed" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("resumed");
    expect(doubles.close).not.toHaveBeenCalled();
  });

  it("starts and stops rosbag recording from the global toolbar", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("button", { name: /开始录制/ });

    await user.click(screen.getByRole("button", { name: /开始录制/ }));
    expect(doubles.invoke).toHaveBeenCalledWith("start_rosbag_recording", { profile: expect.any(Object) });
    expect(await screen.findByRole("button", { name: /停止录制/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText(/rosbag 录制已开始/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /停止录制/ }));
    expect(doubles.invoke).toHaveBeenCalledWith("stop_rosbag_recording", { profile: expect.any(Object) });
    expect(await screen.findByRole("button", { name: /开始录制/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("saves diagnostics, resets layout and persists connection and toolbar settings", async () => {
    localStorage.setItem("easy-debug-layout", JSON.stringify({ leftWidth: 400, rightWidth: 500, leftTopRatio: 0.3 }));
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });

    await user.click(screen.getByRole("button", { name: /诊断快照/ }));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("save_diagnostics_snapshot", {
      localPath: "/tmp/robot-console-diagnostics.json",
      content: expect.stringContaining('"schemaVersion": 1'),
    }));

    await user.click(screen.getByRole("button", { name: /重置布局/ }));
    const workspace = container.querySelector<HTMLElement>(".workspace")!;
    expect(workspace.style.getPropertyValue("--left-width")).toBe("270px");
    expect(workspace.style.getPropertyValue("--right-width")).toBe("330px");

    await user.click(screen.getByRole("button", { name: /连接配置/ }));
    const connectionDialog = screen.getByRole("dialog", { name: "连接配置" });
    expect(within(connectionDialog).queryByLabelText("配置名称")).not.toBeInTheDocument();
    expect(within(connectionDialog).queryByLabelText("JointState Topic")).not.toBeInTheDocument();
    await user.clear(within(connectionDialog).getByLabelText("SSH 主机"));
    await user.type(within(connectionDialog).getByLabelText("SSH 主机"), "next-jetson");
    await user.click(within(connectionDialog).getByText("高级"));
    expect(within(connectionDialog).getByLabelText("ROS_DOMAIN_ID")).toBeVisible();
    await user.click(within(connectionDialog).getByRole("button", { name: "保存配置" }));
    expect(JSON.parse(localStorage.getItem("easy-debug-profile")!)).toMatchObject({
      host: "next-jetson",
      jointStateTopic: "/stm32/joint_states",
      urdfTopic: "/robot_description",
    });

    await user.click(screen.getByRole("button", { name: /设置/ }));
    const settingsDialog = screen.getByRole("dialog", { name: "应用设置" });
    const interval = within(settingsDialog).getByLabelText("Topics / Controller 自动刷新间隔（秒）");
    await user.clear(interval);
    await user.type(interval, "45");
    await user.click(within(settingsDialog).getByRole("button", { name: "保存设置" }));
    expect(JSON.parse(localStorage.getItem("robot-console-toolbar-settings")!)).toMatchObject({ refreshIntervalSeconds: 45 });
  });

  it("uses only the left navigation to enter and leave Calibration", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("joint_state_broadcaster");

    await user.click(screen.getByRole("button", { name: "Joint4 Calibration" }));
    expect(await screen.findByText("多姿态重力与 camera_link 负载标定")).toBeVisible();
    expect(screen.queryByRole("group", { name: "页面切换" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Topics" }));
    expect(await screen.findByRole("tab", { name: "Robot View" })).toBeVisible();
  });

  it("adds numeric fields from Topic Inspector into Monitor panels", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("button", { name: /\/stm32\/joint_states/ });
    emitRosReady();
    expect(await screen.findByText("ROS 就绪")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Monitor" }));
    await user.click(screen.getByRole("button", { name: "新建空仪表盘" }));
    await user.click(screen.getByRole("tab", { name: /Motor Torque/ }));
    await user.click(screen.getByRole("button", { name: "Topics" }));
    await user.click(screen.getByRole("button", { name: /\/stm32\/joint_states/ }));
    act(() => {
      doubles.listener?.({
        op: "topic_message",
        topic: "/stm32/joint_states",
        data: { name: ["j1", "j2"], position: [0.1, 0.2], effort: [1, 2, 3, 4, 5, 6, 7] },
      });
    });
    const json = await screen.findByLabelText("Topic JSON");
    await user.pointer({ keys: "[MouseRight]", target: json.querySelector('[data-monitor-path="effort"]') as Element });
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await user.click(screen.getByRole("menuitem", { name: /New Dashboard/ }));
    await user.click(screen.getByRole("menuitem", { name: "＋ 新建 Panel" }));
    expect(await screen.findByRole("heading", { name: "Monitor" })).toBeVisible();
    expect(localStorage.getItem("robot-console-page")).toBe("monitor");
    expect(screen.getByRole("tab", { name: /New Dashboard/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/1 个 Panel · 窗口/)).toBeVisible();
    expect(screen.getByLabelText("effort[0] 曲线")).toBeVisible();
    expect(screen.getByLabelText("Panel 数据序列").children).toHaveLength(7);
    getContext.mockRestore();
  });


  it("shows connect step progress, status lights, readable errors and copy button", async () => {
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.reject(new Error("Permission denied (publickey)"));
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    expect((await screen.findAllByText(/SSH 认证失败/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Permission denied/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("连接步骤")).toBeVisible();
    expect(screen.getByLabelText("连接状态灯")).toBeVisible();
    expect(screen.getByText("SSH 失败")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "复制错误" }));
    expect(await screen.findByRole("button", { name: "已复制" })).toBeVisible();
  });

  it("quick-picks a recent host after a successful SSH and warns on domain mismatch", async () => {
    localStorage.setItem("easy-debug-profile", JSON.stringify({ host: "alpha", username: "bot", sshPort: 22, rosDomainId: 42 }));
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByLabelText("SSH 主机")).toHaveValue("alpha");
    await user.click(screen.getByText("高级"));
    expect(screen.getByLabelText("连接状态灯")).toHaveTextContent("ROS_DOMAIN_ID=42");
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });
    expect(screen.getByLabelText("连接状态灯")).toBeVisible();
    expect(screen.getByText("等待 JointState")).toBeVisible();
    act(() => {
      doubles.listener?.({
        op: "topic_message",
        topic: "/stm32/joint_states",
        data: { name: ["j1"], position: [0.1] },
      });
      doubles.listener?.({
        op: "topic_message",
        topic: "/stm32/status",
        data: { fault_code: 0 },
      });
    });
    expect(await screen.findByText("ROS 就绪")).toBeVisible();
    expect(screen.getByText("HardwareStatus OK")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "断开" }));
    expect(await screen.findByRole("button", { name: "连接 Jetson" })).toBeVisible();
    expect(screen.getByLabelText("最近主机")).toBeVisible();
    await user.clear(screen.getByLabelText("SSH 主机"));
    await user.type(screen.getByLabelText("SSH 主机"), "other");
    await user.click(screen.getByRole("button", { name: /alpha/ }));
    expect(screen.getByLabelText("SSH 主机")).toHaveValue("alpha");
    expect(screen.getByLabelText("SSH 用户名")).toHaveValue("bot");
  });

  it("opens Monitor from navigation with torque template and bag playback controls", async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("banner", { name: "已连接工具条" });
    emitRosReady();
    expect(await screen.findByText("ROS 就绪")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Monitor" }));
    expect(await screen.findByRole("heading", { name: "Monitor" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Motor Torque/ })).toBeVisible();
    expect(screen.getByText(/7 个 Panel · 窗口/)).toBeVisible();
    expect(screen.getByLabelText("effort[0] 曲线")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Bag 回放" }));
    await user.clear(screen.getByLabelText("Jetson bag 路径"));
    await user.type(screen.getByLabelText("Jetson bag 路径"), "robot-console-bags/demo");
    await user.click(screen.getByRole("button", { name: "开始回放" }));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("start_rosbag_playback", {
      profile: expect.any(Object),
      bagPath: "robot-console-bags/demo",
    }));
    expect(await screen.findByRole("button", { name: /停止回放/ })).toBeVisible();
    getContext.mockRestore();
  });


  it("navigates to Status by default after connect and collapses host switching into the topbar", async () => {
    localStorage.removeItem("easy-debug-navigate-status-on-connect");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    expect(await screen.findByRole("heading", { name: "Status" })).toBeVisible();
    expect(screen.getByRole("banner", { name: "已连接工具条" })).toBeVisible();
    expect(screen.getByRole("button", { name: /断开并重连…/ })).toBeVisible();
    expect(localStorage.getItem("robot-console-page")).toBe("status");
    await user.click(screen.getByRole("button", { name: /断开并重连…/ }));
    expect(await screen.findByRole("button", { name: "连接 Jetson" })).toBeVisible();
  });

  it("repeats Teleop start/stop without publishing an isolated motor command", async () => {
    localStorage.removeItem("easy-debug-navigate-status-on-connect");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("heading", { name: "Status" });
    await user.click(screen.getByRole("tab", { name: /控制模式/ }));
    emitRosReady();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      await user.click(screen.getByRole("button", { name: "Teleop" }));
      await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({ mode: "teleop" })));
      await waitFor(() => expect(screen.getByRole("button", { name: "Teleop" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "停止" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "停止" })).toBeEnabled());
    }
    expect(doubles.invoke.mock.calls.filter(([command, args]) => command === "start_arm_mode" && args.mode === "teleop")).toHaveLength(5);
    expect(doubles.invoke.mock.calls.filter(([command, args]) => command === "start_arm_mode" && args.mode === "stop")).toHaveLength(5);
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command" }));
    expect(doubles.send).not.toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command" }));
  });

  it("keeps Teleop busy until native self-check completes and surfaces its failure", async () => {
    localStorage.removeItem("easy-debug-navigate-status-on-connect");
    const implementation = doubles.invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    doubles.invoke.mockImplementation((command: string, args: unknown) => command === "start_arm_mode"
      ? new Promise((resolve) => { finish = resolve; }) : implementation(command, args));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("heading", { name: "Status" });
    await user.click(screen.getByRole("tab", { name: /控制模式/ }));
    emitRosReady();
    await user.click(screen.getByRole("button", { name: "Teleop" }));
    expect(screen.getByRole("button", { name: "启动中…" })).toBeDisabled();
    await act(async () => finish({ ok: false, exitCode: 1, message: "Teleop 启动失败", detail: "COMMAND_LOSS_LATCHED" }));
    expect(await screen.findByText("Teleop 启动失败：COMMAND_LOSS_LATCHED")).toBeVisible();
    expect(screen.getByRole("button", { name: "Teleop" })).toBeEnabled();
  });

  it("uses explicit DISABLE stop only after confirming physical support", async () => {
    localStorage.removeItem("easy-debug-navigate-status-on-connect");
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("heading", { name: "Status" });
    await user.click(screen.getByRole("tab", { name: /控制模式/ }));
    await user.click(screen.getByRole("button", { name: "解除输出" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(doubles.invoke).not.toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({ mode: "disable-stop" }));
    await user.click(screen.getByRole("button", { name: "解除输出" }));
    await user.click(screen.getByRole("checkbox", { name: "机械臂已支撑，可以解除输出" }));
    await user.click(screen.getByRole("button", { name: "确认 DISABLE 并停止" }));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({ mode: "disable-stop" })));
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command" }));
  });

  it("gates Monitor and Motor until JointState smoke is green", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("banner", { name: "已连接工具条" });
    const monitor = screen.getByRole("button", { name: "Monitor" });
    const motor = screen.getByRole("button", { name: "Motor" });
    expect(monitor).toBeDisabled();
    expect(motor).toBeDisabled();
    expect(monitor.getAttribute("title")).toContain("JointState");
    emitRosReady();
    expect(await screen.findByText("ROS 就绪")).toBeVisible();
    expect(screen.getByRole("button", { name: "Monitor" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Motor" })).not.toBeDisabled();
  });

  it("shows Bridge version badge and opens upgrade prompt on mismatch click", async () => {
    doubles.connect.mockResolvedValueOnce({
      bridge_version: "0.1.0",
      bridge_build_id: "ffffffffffffffff",
      ros_distro: "humble",
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const badge = await screen.findByRole("button", { name: /Bridge 不匹配/ });
    expect(badge).toBeVisible();
    await user.click(badge);
    expect(await screen.findByRole("dialog", { name: "Bridge 版本不匹配" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "跳过" }));
  });

  it("jumps from fault chip to Status Hardware card", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("banner", { name: "已连接工具条" });
    act(() => {
      doubles.listener?.({
        op: "topic_message",
        topic: "/stm32/status",
        data: { fault_code: 4, mode: 1, mode_name: "POSITION" },
      });
    });
    const fault = await screen.findByRole("button", { name: /Fault 4/ });
    await user.click(fault);
    expect(await screen.findByRole("heading", { name: "Status" })).toBeVisible();
    const hardware = await screen.findByRole("article", { name: "Hardware" });
    expect(hardware).toHaveAttribute("data-highlighted", "true");
    expect(hardware).toHaveTextContent(/fault_code/);
    await user.click(screen.getByRole("tab", { name: /连接/ }));
    expect(hardware).not.toBeVisible();
    await user.click(fault);
    expect(hardware).toBeVisible();
    expect(screen.getByRole("tab", { name: /硬件健康/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows last connect history and retries a failed step from the start", async () => {
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.reject(new Error("Permission denied (publickey)"));
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    expect((await screen.findAllByText(/SSH 认证失败/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
    expect(screen.getByLabelText("上次连接记录")).toHaveTextContent(/失败/);
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.resolve("ready");
      if (command === "start_session") return Promise.resolve(19001);
      if (command === "check_micro_ros_agent") return Promise.resolve({
        loadState: "loaded", activeState: "active", subState: "running", result: "success",
        mainPid: 10, unitFileState: "enabled", description: "micro ROS agent",
      });

      if (command === "probe_jetson_usb") return Promise.resolve({
        mcuPresent: true, mcuVidPid: "0483:5740", serialPath: "/dev/ttyACM0",
        realsensePresent: false, realsenseLines: [], rawLsusb: "0483:5740",
      });
      if (command === "probe_arm_mode") return Promise.resolve({
        mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false,
        teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "idle",
      });
      if (command === "restart_micro_ros_agent") return Promise.resolve({ ok: true, exitCode: 0, message: "micro-ROS Agent 已重启", detail: "" });
      if (command === "start_arm_mode") return Promise.resolve({ ok: true, exitCode: 0, message: "arm mode started", detail: "" });
      if (command === "check_ros_controllers") return Promise.resolve({
        manager: "/controller_manager", available: true, controllers: [], message: "",
      });
      if (command === "get_rosbag_status") return Promise.resolve({ recording: false, pid: 0, outputPath: "", message: "" });
      if (command === "get_rosbag_play_status") return Promise.resolve({ playing: false, pid: 0, bagPath: "", message: "" });
      return Promise.resolve(undefined);
    });
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("banner", { name: "已连接工具条" })).toBeVisible();
  });

  it("connects with Enter and dismisses the error banner with Escape", async () => {
    doubles.invoke.mockImplementation((command: string) => {
      if (command === "check_ssh") return Promise.reject(new Error("Connection refused"));
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    screen.getByLabelText("SSH 主机").focus();
    await user.keyboard("{Enter}");
    expect((await screen.findAllByText(/无法到达主机/)).length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });


});
