import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { EXPECTED_BRIDGE_BUILD_ID } from "./bridgeVersion";
import type { MotionGroup } from "./motionGroupsLogic";

const doubles = vi.hoisted(() => ({
  invoke: vi.fn(),
  controllers: vi.fn(),
  controllerSequence: 0,
  listen: vi.fn(),
  deployListener: undefined as ((event: { payload: string }) => void) | undefined,
  deployUnlisten: vi.fn(),
  save: vi.fn(),
  connect: vi.fn().mockResolvedValue({
    bridge_version: "0.1.0",
    bridge_build_id: "bddd7fcc6d04",
    ros_distro: "humble",
    controllers_info_supported: true,
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
  listeners: new Set<(message: unknown) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke, Channel: class { onmessage = (_event: unknown) => {}; } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: doubles.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: doubles.save }));
vi.mock("./bridge", () => ({
  BridgeClient: class {
    connect = doubles.connect;
    attach = doubles.connect;
    listTopics = doubles.listTopics;
    getGraph = doubles.getGraph;
    getTopicInfo = doubles.getTopicInfo;
    getNodeInfo = doubles.getNodeInfo;
    send = doubles.send;
    request = (message: {op:string;refresh?:boolean}, ...args: unknown[]) => {
      if(message.op !== "controllers_info") return doubles.request(message,...args);
      return Promise.resolve(doubles.controllers(message)).then(status => {
        if(status?.op === "controllers_info") return status;
        return {op:"controllers_info",supported:true,manager:"/controller_manager",available:status?.available === true,fresh:status?.available === true,has_snapshot:true,snapshot_sequence:++doubles.controllerSequence,snapshot_age_ms:0,snapshot_time_ms:Date.now(),query_state:status?.available?"ready":"unavailable",query_pending:false,retry_after_ms:0,request_wait_ms:0,controllers:(status?.controllers ?? []).map((c:{name:string;typeName:string;state:string})=>({name:c.name,type_name:c.typeName,state:c.state})),message:status?.message ?? ""};
      });
    };
    close = doubles.close;
    onMessage(listener: (message: unknown) => void) {
      doubles.listeners.add(listener);
      doubles.listener = (message) => doubles.listeners.forEach((fn) => fn(message));
      return () => { doubles.listeners.delete(listener); };
    }
  },
}));
vi.mock("./UrdfViewer", () => ({
  UrdfViewer: ({ xml, trajectoryController, onSendTrajectory, onSavePose, savePoseDisabledReason }: {
    onSavePose?(): void;
    savePoseDisabledReason?: string;
    xml: string;
    trajectoryController: { name: string; topic: string } | null;
    onSendTrajectory(request: { jointNames: string[]; points: { positions: number[]; time_from_start: number }[] }): Promise<void>;
  }) => (
    <div data-testid="urdf">
      <button type="button" onClick={onSavePose} disabled={Boolean(savePoseDisabledReason)}>保存当前姿态</button>
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
          }).then(() => {
            const node = document.querySelector<HTMLElement>("[data-testid='trajectory-error']");
            if (node) node.textContent = "";
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
  it("opens offline hand-eye without connecting and preserves settings on return", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", {name: "手眼标定 / 离线样本"}));
    await user.selectOptions(screen.getByLabelText("ArUco dictionary"), "DICT_6X6_250");
    await user.click(screen.getByRole("button", {name: "返回连接"}));
    await user.click(screen.getByRole("button", {name: "手眼标定 / 离线样本"}));
    expect(screen.getByLabelText("ArUco dictionary")).toHaveValue("DICT_6X6_250");
    expect(doubles.connect).not.toHaveBeenCalled();
  });

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
    doubles.controllerSequence = 0;
    doubles.deployListener = undefined;
    doubles.listen.mockImplementation(async (event: string, handler: (value: { payload: string }) => void) => {
      if (event === "bridge-deploy-progress") { doubles.deployListener = handler; return doubles.deployUnlisten; }
      return () => {};
    });
    doubles.save.mockResolvedValue("/tmp/robot-console-diagnostics.json");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    doubles.controllers.mockImplementation(() => {return Promise.resolve({
        manager: "/controller_manager",
        fresh: true, available: true,
        controllers: [
          { name: "joint_state_broadcaster", typeName: "joint_state_broadcaster/JointStateBroadcaster", state: "active" },
          { name: "arm_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "inactive" },
        ],
        message: "",
      });});
    const documents = new Map<string, {revision: number; content: string | null}>();
    doubles.invoke.mockImplementation((command: string, args?: { controllerName?: string; action?: string; bagPath?: string; key?: string; expected?: number; content?: string }) => {
      if (command === "editor_document_read" || command === "editor_document_commit") {
        const key = args!.key!, before = documents.get(key) ?? {revision: 0, content: null};
        if (command === "editor_document_read") return Promise.resolve(before);
        if (args!.expected !== before.revision) return Promise.resolve({accepted: false, snapshot: before});
        const snapshot = {revision: before.revision + 1, content: args!.content!}; documents.set(key, snapshot);
        return Promise.resolve({accepted: true, snapshot});
      }
      if (command === "native_collection_operation_snapshot") return Promise.resolve(null);
      if (command === "native_bag_operation_snapshot") return Promise.resolve([]);
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

  it("returns from the disconnected form to an existing native Monitor without connecting", async () => {
    const user = userEvent.setup();
    const originalInvoke = doubles.invoke.getMockImplementation()!;
    const previousResizeObserver = globalThis.ResizeObserver;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    doubles.invoke.mockImplementation((command: string, args: unknown) => {
      if (command === "workspace_snapshot") return Promise.resolve({ selected: "monitor", pages: {
        monitor: { detached: false, ready: true, visible: false, busy_reason: "" },
      } });
      if (command === "native_observation_snapshot") return Promise.resolve({ epoch: 0, revision: 0, connected: false, entries: {} });
      if (command === "native_task_snapshot") return Promise.resolve(null);
      return originalInvoke(command, args);
    });
    const view = render(<App />);
    try {
      await user.click(await screen.findByRole("button", { name: "返回已打开页面" }));
      expect(screen.getByRole("combobox", { name: "已打开页面" })).toHaveValue("monitor");
      await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("workspace_select", { page: "monitor" }));
      expect(doubles.connect).not.toHaveBeenCalled();
      expect(doubles.invoke).not.toHaveBeenCalledWith("start_session", expect.anything());
      await user.click(screen.getByRole("button", { name: "返回连接" }));
      expect(screen.getByRole("button", { name: "连接 Jetson" })).toBeVisible();
      expect(doubles.invoke).toHaveBeenCalledWith("workspace_cover", { covered: true });
    } finally {
      view.unmount();
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      globalThis.ResizeObserver = previousResizeObserver;
      doubles.invoke.mockImplementation(originalInvoke);
    }
  });

  it("keeps another page's preferences unchanged when native main and handeye mount", async () => {
    const base = doubles.invoke.getMockImplementation()!;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {value:{},configurable:true});
    doubles.invoke.mockImplementation((command, args) => {
      if(command === "workspace_snapshot") return Promise.resolve({selected:"status",pages:{}});
      if(command === "native_observation_snapshot") return Promise.resolve({epoch:0,revision:0,connected:false,entries:{}});
      if(command === "native_task_snapshot") return Promise.resolve(null);
      if(command === "native_bridge_context") return Promise.resolve({epoch:0,connected:false,profile:null,error:null});
      return base(command,args);
    });
    localStorage.setItem("robot-console-page", "status");
    const writes = vi.spyOn(localStorage, "setItem");
    const main = render(<App />);
    const handeye = render(<App hostedPage="handeye" />);
    try {
      await screen.findByRole("region", {name:"手眼标定内容"});
      for (const key of ["robot-console-motion-tab", "robot-console-motion-controllers", "easy-debug-panels", "easy-debug-sidebars", "easy-debug-layout"]) {
        expect(writes.mock.calls.filter(([written]) => written === key)).toHaveLength(0);
      }
      for (const key of ["robot-console-page", "robot-console-nav-expanded", "robot-console-workspace-motion-nav", "easy-debug-navigate-status-on-connect"]) {
        expect(writes.mock.calls.filter(([written]) => written === key)).toHaveLength(1);
      }
    } finally {
      main.unmount(); handeye.unmount(); writes.mockRestore();
      delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;
      doubles.invoke.mockImplementation(base);
    }
  });

  it("keeps offline handeye in the common host so a native Motion selection updates main", async () => {
    const user=userEvent.setup(), base=doubles.invoke.getMockImplementation()!, baseListen=doubles.listen.getMockImplementation()!;
    const resize=globalThis.ResizeObserver;
    let workspaceEvent: ((message:{payload:unknown})=>void) | undefined;
    Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
    globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
    doubles.listen.mockImplementation((name,handler) => {
      if(name==="workspace-state") workspaceEvent=handler;
      return baseListen(name,handler);
    });
    doubles.invoke.mockImplementation((command,args) => {
      if(command==="workspace_snapshot") return Promise.resolve({selected:"status",pages:{}});
      if(command==="native_observation_snapshot") return Promise.resolve({epoch:0,revision:0,connected:false,entries:{}});
      if(command==="native_task_snapshot") return Promise.resolve(null);
      return base(command,args);
    });
    const view=render(<App />);
    try {
      await user.click(screen.getByRole("button",{name:"手眼标定 / 离线样本"}));
      expect(await screen.findByLabelText("手眼标定 页面区域")).toBeVisible();
      expect(screen.getByRole("combobox",{name:"已打开页面"})).toHaveValue("handeye");
      await waitFor(()=>expect(workspaceEvent).toBeDefined());
      act(()=>workspaceEvent!({payload:{selected:"motion",pages:{handeye:{ready:true,visible:false},motion:{ready:true,visible:true}},motion_navigation:{revision:1,tab:"robot",profile_key:"jetson||22"}}}));
      expect(await screen.findByLabelText("Motion 页面区域")).toBeVisible();
      expect(screen.getByRole("combobox",{name:"已打开页面"})).toHaveValue("motion");
      expect(screen.queryByLabelText("手眼标定 页面区域")).not.toBeInTheDocument();
      expect(doubles.connect).not.toHaveBeenCalled();
    } finally {view.unmount();delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;globalThis.ResizeObserver=resize;doubles.invoke.mockImplementation(base);doubles.listen.mockImplementation(baseListen);}
  });

  it("requests Robot View in the existing native Motion page from handeye", async () => {
    const user=userEvent.setup(), base=doubles.invoke.getMockImplementation()!;
    Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
    doubles.invoke.mockImplementation((command,args) => {
      if(command==="workspace_snapshot") return Promise.resolve({selected:"handeye",pages:{handeye:{ready:true,visible:true,detached:true,busy_reason:""}}});
      if(command==="native_observation_snapshot") return Promise.resolve({epoch:0,revision:0,connected:false,entries:{}});
      if(command==="native_task_snapshot") return Promise.resolve(null);
      if(command==="native_bridge_context") return Promise.resolve({epoch:0,connected:false,profile:null,error:null});
      return base(command,args);
    });
    const view=render(<App hostedPage="handeye" />);
    try {
      await user.click(await screen.findByRole("button",{name:"前往 Motion 调整姿态"}));
      await waitFor(()=>expect(doubles.invoke).toHaveBeenCalledWith("workspace_open_motion",{tab:"robot",profileKey:"jetson||22"}));
      expect(screen.getByRole("region",{name:"手眼标定内容"})).toBeVisible();
      expect(doubles.connect).not.toHaveBeenCalled();
    } finally {view.unmount();delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;doubles.invoke.mockImplementation(base);}
  });

  it("opens offline pose and group management in the single native Motion host", async () => {
    const user = userEvent.setup(), base = doubles.invoke.getMockImplementation()!;
    const resize = globalThis.ResizeObserver;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {value:{},configurable:true});
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    doubles.invoke.mockImplementation((command, args) => {
      if(command === "workspace_snapshot") return Promise.resolve({selected:"status",pages:{}});
      if(command === "native_observation_snapshot") return Promise.resolve({epoch:0,revision:0,connected:false,entries:{}});
      if(command === "native_task_snapshot") return Promise.resolve(null);
      return base(command,args);
    });
    const view = render(<App />);
    try {
      for (const [label,tab] of [["管理姿态库","positions"],["管理动作组","groups"]]) {
        await user.click(screen.getByRole("button", {name:label}));
        await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("workspace_open_motion",{tab,profileKey:"jetson||22"}));
        expect(screen.getByLabelText("Motion 页面区域")).toBeVisible();
        expect(screen.queryByRole("region",{name:"姿态库"})).not.toBeInTheDocument();
        expect(screen.queryByRole("region",{name:"动作组编辑器"})).not.toBeInTheDocument();
        await user.click(screen.getByRole("button",{name:"返回连接"}));
      }
      expect(doubles.connect).not.toHaveBeenCalled();
    } finally {view.unmount(); delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__; globalThis.ResizeObserver=resize; doubles.invoke.mockImplementation(base);}
  });

  it("keeps an unsaved pose draft while switching Motion tabs", async () => {
    const base=doubles.invoke.getMockImplementation()!;
    doubles.invoke.mockImplementation((command,args)=>command === "editor_document_read" && args?.key === "positions"
      ? Promise.resolve({revision:1,content:JSON.stringify({schemaVersion:2,profiles:{"jetson||22":{positions:[{id:"p",name:"Keep pose",positions:[0,0,0,0,0,0]}]}}})}) : base(command,args));
    const user=userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button",{name:"连接 Jetson"}));
    await user.click(await screen.findByRole("button",{name:"Motion"}));
    await user.click(screen.getByRole("tab",{name:"姿态库"}));
    await user.click(screen.getByRole("button",{name:"Keep pose更多操作"}));
    await user.click(screen.getByRole("menuitem",{name:"编辑姿态"}));
    await user.clear(screen.getByLabelText("点位名称")); await user.type(screen.getByLabelText("点位名称"),"Unsaved pose");
    await user.click(screen.getByRole("tab",{name:"动作组"}));
    await user.click(screen.getByRole("tab",{name:"姿态库"}));
    expect(screen.getByLabelText("点位名称")).toHaveValue("Unsaved pose");
    expect(doubles.invoke.mock.calls.some(([op])=>op === "editor_document_commit")).toBe(false);
  });

  it("provides a keyboard-focusable hand-eye content region only on its connected page", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", {name: "连接 Jetson"}));
    await user.click(await screen.findByRole("button", {name: "手眼标定"}));
    const region=screen.getByRole("region", {name: "手眼标定内容"});
    expect(region).toHaveAttribute("tabIndex", "0");
    expect(within(region).getByRole("tab", {name: "Target · 标定板"})).toBeVisible();
    await user.click(screen.getByRole("button", {name: "Topics"}));
    expect(screen.queryByRole("region", {name: "手眼标定内容"})).not.toBeInTheDocument();
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
        bridge_build_id: EXPECTED_BRIDGE_BUILD_ID,
        ros_distro: "humble",
      });
    doubles.controllers.mockImplementation(() => {return Promise.resolve({
        manager: "/controller_manager", fresh: true, available: true, controllers: [], message: "",
      });});
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

  it("accumulates Bridge upgrade output and keeps it after failure, ignoring late progress", async () => {
    doubles.connect.mockResolvedValueOnce({ bridge_version: "0.1.0", bridge_build_id: "old-build", ros_distro: "humble" });
    let fail!: (reason: Error) => void;
    const pending = new Promise((_, reject) => { fail = reject; });
    const normal = doubles.invoke.getMockImplementation()!;
    doubles.invoke.mockImplementation((command, args) => command === "deploy_bridge" ? pending : normal(command, args));
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const dialog = await screen.findByRole("dialog", { name: "Bridge 版本不匹配" });
    await user.click(within(dialog).getByRole("button", { name: "升级" }));
    await waitFor(() => expect(doubles.deployListener).toBeTypeOf("function"));
    act(() => {
      doubles.deployListener?.({ payload: "[build] starting" });
      doubles.deployListener?.({ payload: "[remote] compiling\n[remote] linking" });
    });
    const log = screen.getByRole("log", { name: "Bridge 升级日志输出" });
    expect(log).toHaveTextContent("准备升级 Bridge");
    expect(log).toHaveTextContent("[build] starting");
    expect(log).toHaveTextContent("[remote] linking");
    await act(async () => fail(new Error("build failed")));
    expect(log).toHaveTextContent("[build] starting");
    expect(log).toHaveTextContent("[error] build failed");
    expect(doubles.deployUnlisten).toHaveBeenCalled();
    act(() => doubles.deployListener?.({ payload: "obsolete output" }));
    expect(log).not.toHaveTextContent("obsolete output");
    await user.click(screen.getByRole("button", { name: /^重试$/ }));
    expect(screen.queryByRole("log", { name: "Bridge 升级日志输出" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /^\/stm32\/status/ }));
    act(() => {
      doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "old-session-urdf" });
      doubles.listener?.({ op: "topic_message", topic: "/stm32/status", data: { fault_code: 4 } });
    });
    await user.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("old-session-urdf");
    await user.click(screen.getByRole("button", { name: "Topics" }));
    expect(screen.getByLabelText("Topic JSON")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "断开" }));
    await screen.findByRole("button", { name: "连接 Jetson" });
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("toolbar", { name: "应用工具栏" });

    await user.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByTestId("urdf")).toHaveTextContent("empty");
    await user.click(screen.getByRole("button", { name: "Topics" }));
    expect(screen.getByText("从左侧或 Topic Graph 选择一个 Topic")).toBeVisible();
    expect(screen.queryByLabelText("Topic JSON")).not.toBeInTheDocument();
  });

  it("does not let a delayed controller response from the old session repopulate state", async () => {
    let resolveOldControllers!: (value: unknown) => void;
    let controllerRequest = 0;
    doubles.controllers.mockImplementation(() => {
        controllerRequest += 1;
        if (controllerRequest === 1) {
          return new Promise((resolve) => { resolveOldControllers = resolve; });
        }
        return Promise.resolve({
          manager: "/controller_manager", fresh: true, available: true,
          controllers: [{ name: "new_controller", typeName: "test/New", state: "active" }], message: "",
        });
      });
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
        manager: "/controller_manager", fresh: true, available: true,
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
    expect(screen.getByRole("button", { name: /^\/stm32\/status/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /\/robot_description/ })).not.toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "std_msgs");
    expect(screen.getByRole("button", { name: /\/robot_description/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^\/stm32\/status/ })).not.toBeInTheDocument();
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
    expect(doubles.controllers).toHaveBeenCalledWith({op:"controllers_info",refresh:false});
    expect(doubles.invoke.mock.calls.some(([command])=>command==="check_ros_controllers")).toBe(false);
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
    await user.click(await screen.findByRole("button", { name: "查看 arm_controller Graph" }));
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
  });

  it("keeps Topics read-only and confirms verified Controller switches only in Motion", async () => {
    const baseInvoke = doubles.invoke.getMockImplementation()!;
    const states = { joint_state_broadcaster: "active", arm_controller: "inactive" };
    doubles.controllers.mockImplementation(() => {return { manager: "/controller_manager", fresh: true, available: true,
        controllers: Object.entries(states).map(([name,state]) => ({name,state,typeName: name === "arm_controller" ? "joint_trajectory_controller/JointTrajectoryController" : "joint_state_broadcaster/JointStateBroadcaster"})), message: "" };});
    doubles.invoke.mockImplementation(async (command, args) => {

      if (command === "switch_ros_controller") {
        states[args.controllerName as keyof typeof states] = args.action === "activate" ? "active" : "inactive";
        return `${args.controllerName} ${args.action} complete`;
      }
      return baseInvoke(command,args);
    });
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("joint_state_broadcaster");
    expect(screen.queryByRole("button", {name:"停用 joint_state_broadcaster"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name:"激活 arm_controller"})).not.toBeInTheDocument();
    expect(doubles.invoke.mock.calls.some(([c]) => c === "switch_ros_controller")).toBe(false);
    await user.click(screen.getByRole("button", {name:"Motion"}));
    await user.click(screen.getByRole("button", {name:"面板"}));
    await user.click(screen.getByRole("button", {name:"展开 Controllers"}));
    const before = doubles.controllers.mock.calls.length;
    await user.click(screen.getByRole("button",{name:"停用 joint_state_broadcaster"}));
    expect(doubles.invoke.mock.calls.some(([c]) => c === "switch_ros_controller")).toBe(false);
    await user.click(screen.getByRole("button",{name:"确认停用"}));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("switch_ros_controller", { profile:expect.any(Object), controllerName:"joint_state_broadcaster", action:"deactivate" }));
    await waitFor(() => expect(doubles.controllers.mock.calls.length).toBeGreaterThanOrEqual(before+2));
    expect(await screen.findByText("joint_state_broadcaster deactivate complete")).toBeVisible();
    await user.click(screen.getByRole("button",{name:"激活 arm_controller"}));
    await user.click(screen.getByRole("button",{name:"确认激活"}));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("switch_ros_controller", {profile:expect.any(Object),controllerName:"arm_controller",action:"activate"}));
    expect(await screen.findByText("arm_controller activate complete")).toBeVisible();
  });

  it("refreshes Controllers from the Bridge every second independently of the Topics interval", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
      await screen.findByText("joint_state_broadcaster");

      const topicCalls = doubles.listTopics.mock.calls.length;
      const controllerCalls = doubles.controllers.mock.calls.length;
      const refreshTopics = screen.getByRole("button", { name: "刷新Topics" });
      const refreshControllers = screen.getByRole("button", { name: "刷新ROS Control" });
      expect(refreshTopics).toBeEnabled();
      expect(refreshControllers).toBeEnabled();

      await user.click(refreshTopics);
      await user.click(refreshControllers);
      await waitFor(() => expect(doubles.listTopics).toHaveBeenCalledTimes(topicCalls + 1));
      await waitFor(() => expect(
        doubles.controllers.mock.calls,
      ).toHaveLength(controllerCalls + 1));

      const automaticRefreshes = intervalSpy.mock.calls
        .filter(([, delay]) => delay === 30_000)
        .map(([callback]) => callback as () => void);
      expect(automaticRefreshes).toHaveLength(2); // Topics Graph adds its own visible-page poller.
      const topicsBeforeAutoRefresh = doubles.listTopics.mock.calls.length;
      const controllersBeforeAutoRefresh = doubles.controllers.mock.calls.length;
      await act(async () => {
        automaticRefreshes.forEach((refresh) => refresh());
        intervalSpy.mock.calls.filter(([, delay])=>delay===1000).forEach(([callback])=>(callback as ()=>void)());
        await Promise.resolve();
      });
      await waitFor(() => expect(doubles.listTopics).toHaveBeenCalledTimes(topicsBeforeAutoRefresh + 1));
      await waitFor(() => expect(
        doubles.controllers.mock.calls,
      ).toHaveLength(controllersBeforeAutoRefresh + 1));

      const lastTopics = await doubles.listTopics.mock.results.at(-1)!.value;
      const lastControllers = await doubles.controllers.mock.results.at(-1)!.value;
      let finishTopics!: (value: unknown) => void, finishControllers!: (value: unknown) => void;
      doubles.listTopics.mockReturnValueOnce(new Promise(resolve => { finishTopics = resolve; }));
      doubles.controllers.mockReturnValueOnce(new Promise(resolve => { finishControllers = resolve; }));
      await act(async () => {
        automaticRefreshes.forEach(refresh => refresh());
        intervalSpy.mock.calls.filter(([, delay]) => delay === 1000).forEach(([callback]) => (callback as () => void)());
      });
      expect(screen.getByRole("button", {name:"刷新全部状态"})).toBeEnabled();
      expect(screen.getByRole("button", {name:"刷新全部状态"}).querySelector(".spin")).toBeNull();
      expect(refreshControllers).toBeEnabled();
      expect(refreshTopics).toBeEnabled();
      await act(async () => { finishTopics(lastTopics); finishControllers(lastControllers); });
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("shows ROS Control query failure without blocking the connected workspace", async () => {
    doubles.controllers.mockImplementation(() => {return Promise.resolve({
        manager: "/controller_manager", available: false, controllers: [],
        message: "controller_manager 服务不可用或查询超时",
      });});
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

      if (command === "start_session") return Promise.resolve(19001);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    const control = await screen.findByRole("region", { name: "ROS Control Controllers" });
    expect(control).toHaveTextContent("服务不可用");
    expect(control).not.toHaveTextContent("离线");
    expect(control).toHaveTextContent("controller_manager 服务不可用或查询超时");
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
  });

  it("selects a topic and independently collapses all three dashboard data panels", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByText("micro-ROS Agent：运行中");
    await user.click(screen.getByRole("button", { name: /^\/stm32\/status/ }));
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

  it("retains one Motion scene while Topics stays read-only and releases RGBD on navigation", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await screen.findByLabelText("ROS Topic Graph");
    expect(screen.queryByTestId("urdf")).not.toBeInTheDocument();
    expect(doubles.send.mock.calls.some(([m]) => m.op === "subscribe_rgbd")).toBe(false);
    expect(screen.queryByRole("button", { name: /激活 arm_controller|停用 joint_state_broadcaster/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Motion" }));
    const viewer = await screen.findByTestId("urdf");
    expect(viewer).toBeVisible();
    expect(doubles.send).toHaveBeenCalledWith(expect.objectContaining({ op: "subscribe_rgbd" }));
    await user.click(screen.getByRole("tab", { name: "姿态库" }));
    expect(viewer).not.toBeVisible();
    expect(doubles.send).toHaveBeenCalledWith({ op: "unsubscribe_rgbd" });
    await user.click(screen.getByRole("tab", { name: "Robot View" }));
    expect(screen.getByTestId("urdf")).toBe(viewer);
    await user.click(screen.getByRole("button", { name: "Topics" }));
    expect(viewer).not.toBeVisible();
    expect(screen.queryByRole("tab", { name: "姿态库" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByTestId("urdf")).toBe(viewer);
    expect(viewer).toBeVisible();
  });

  it("leases images only while Inspector data is visible, releases and resubscribes on return", async () => {
    doubles.listTopics.mockResolvedValueOnce([{ name: "/test/image", types: ["sensor_msgs/msg/Image"] }]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: /^\/test\/image/ }));
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
    expect(within(screen.getByRole("main", {name:"Topics"})).queryByText(/1 条/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "收起右侧栏" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({ op: "unsubscribe", topic: "/test/image" }));
  });

  it("routes URDF, joint state and hardware status messages", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "Motion" }));
    await user.click(screen.getByRole("button", {name:"连接与运动状态"}));
    await screen.findByText("micro-ROS Agent：运行中");
    doubles.listener?.({ op: "topic_message", topic: "/robot_description", data: "<robot/>" });
    await waitFor(() => expect(screen.getByTestId("urdf")).toHaveTextContent("<robot/>"));
  });

  it("opens Topic Graph and subscribes a selected topic for inspection", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));

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
    await user.click(await screen.findByRole("button", { name: /^\/stm32\/status/ }));
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
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
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
    expect(screen.queryByTestId("motor")).not.toBeInTheDocument();
  });

  it("refuses to send a trajectory while no trajectory controller is active", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "Motion" }));
    await within(screen.getByRole("main", {name:"Motion"})).findByText("arm_controller");

    // 默认 mock 中 arm_controller 是 inactive，因此不构成可下发的轨迹控制器。
    expect(screen.getByTestId("trajectory-controller")).toHaveTextContent("none");
    await user.click(screen.getByTestId("send-trajectory"));
    expect(await screen.findByTestId("trajectory-error")).toHaveTextContent("failed: 没有激活的轨迹控制器");
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "trajectory_command" }));
  });

  it("sends a JointTrajectory to the active trajectory controller's topic", async () => {
    doubles.controllers.mockImplementation(() => {return Promise.resolve({
        manager: "/controller_manager",
        fresh: true, available: true,
        controllers: [
          { name: "joint_state_broadcaster", typeName: "joint_state_broadcaster/JointStateBroadcaster", state: "active" },
          { name: "arm/trajectory_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "active" },
        ],
        message: "",
      });});
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

      if (command === "start_session") return Promise.resolve(19001);
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "Motion" }));
    await within(screen.getByRole("main", {name:"Motion"})).findByText("arm/trajectory_controller");

    expect(screen.getByTestId("trajectory-controller")).toHaveTextContent("arm/trajectory_controller@/arm/trajectory_controller/joint_trajectory");
    expect(doubles.request).toHaveBeenCalledWith({ op: "subscribe", topic: "/arm/trajectory_controller/controller_state", type: "control_msgs/msg/JointTrajectoryControllerState" });
    await user.click(screen.getByTestId("send-trajectory"));
    expect(screen.getByTestId("trajectory-error")).toHaveTextContent("JointState 反馈缺失或已过期");
    act(() => doubles.listener?.({ op: "topic_message", topic: "/stm32/joint_states", data: { name: ["joint1", "joint2"], position: [0, 0] } }));
    await user.click(screen.getByTestId("send-trajectory"));
    expect(screen.getByTestId("trajectory-error")).toHaveTextContent("轨迹控制器反馈缺失或已过期");
    const feedback = (names = ["joint1", "joint2"]) => act(() => {
      doubles.listener?.({ op: "topic_message", topic: "/stm32/joint_states", data: { name: ["joint1", "joint2", "gripper_finger_left_joint"], position: [0, 0, 0.5] } });
      doubles.listener?.({ op: "topic_message", topic: "/arm/trajectory_controller/controller_state", data: { joint_names: names } });
    });
    feedback(["joint1", "joint2", "gripper_finger_left_joint"]);
    await user.click(screen.getByTestId("send-trajectory"));
    expect(screen.getByTestId("trajectory-error")).toHaveTextContent("轨迹关节列表与当前控制器不匹配");
    feedback();
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1500);
    try {
      await user.click(screen.getByTestId("send-trajectory"));
      expect(screen.getByTestId("trajectory-error")).toHaveTextContent("JointState 反馈缺失或已过期");
      act(() => doubles.listener?.({ op: "topic_message", topic: "/stm32/joint_states", data: { name: ["joint1", "joint2"], position: [0, 0] } }));
      await user.click(screen.getByTestId("send-trajectory"));
      expect(screen.getByTestId("trajectory-error")).toHaveTextContent("轨迹控制器反馈缺失或已过期");
      expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "trajectory_command" }), expect.anything());
    } finally { clock.mockRestore(); }
    feedback();
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
    expect(within(control).getByText("轨迹")).toBeVisible();
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
    expect(screen.queryByRole("tab", { name: "Robot View" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "DataGraph" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Monitor" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Motion" })).toBeVisible();

    const topicCalls = doubles.listTopics.mock.calls.length;
    const controllerCalls = doubles.controllers.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "刷新全部状态" }));
    await waitFor(() => expect(doubles.listTopics.mock.calls.length).toBe(topicCalls + 1));
    await waitFor(() => expect(
      doubles.controllers.mock.calls.length,
    ).toBe(controllerCalls + 1));

    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
  });

  it("subscribes the error dashboard without a controller activation and resets pairing on pause/reconnect", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    emitRosReady();
    await user.click(await screen.findByRole("button", { name: "Monitor" }));
    await user.click(screen.getByRole("button", { name: "添加运动误差仪表盘" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({ op: "subscribe", topic: "/arm_trajectory_controller/controller_state", type: "control_msgs/msg/JointTrajectoryControllerState" }));
    const names = Array.from({ length: 6 }, (_, i) => `joint${i + 1}`);
    const emit = (topic: string, data: unknown) => act(() => doubles.listener?.({ op: "topic_message", topic, data }));
    const state = { header: { stamp: { sec: 10, nanosec: 0 } }, joint_names: names, actual: { positions: names.map(() => 0) }, desired: { positions: names.map(() => .1) } };
    emit("/stm32/joint_states", { header: state.header, name: names, position: names.map(() => 0) });
    emit("/arm_trajectory_controller/controller_state", state);
    expect(screen.getByLabelText("运动误差数据说明")).toHaveTextContent("六轴数据有效；最新采样，未对齐");
    await user.click(screen.getByRole("button", { name: "暂停跟随" }));
    await user.click(screen.getByRole("button", { name: "跟随实时" }));
    emit("/arm_trajectory_controller/controller_state", state);
    expect(screen.getByLabelText("运动误差数据说明")).toHaveTextContent("等待两路有效反馈");
    await user.click(screen.getByRole("button", { name: "断开" }));
    await user.click(await screen.findByRole("button", { name: "连接 Jetson" }));
    await screen.findByRole("button", { name: "断开" });
    emitRosReady();
    await user.click(screen.getByRole("button", { name: "Monitor" }));
    expect(screen.getByRole("tab", { name: /运动误差/ })).toBeVisible();
    expect(screen.getByLabelText("运动误差数据说明")).toHaveTextContent("等待控制器反馈");
    emit("/arm_trajectory_controller/controller_state", state);
    expect(screen.getByLabelText("运动误差数据说明")).toHaveTextContent("源时间戳无效");
    expect(doubles.send.mock.calls.some(([m]) => m.op === "trajectory_command" || m.op === "joint_command")).toBe(false);
  });

  it("pauses and resumes live topic data without disconnecting", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "Motion" }));
    await user.click(screen.getByRole("button", {name:"更多工具"}));
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

  it("uses shared native recording truth and verifies again after a toolbar command", async () => {
    const user=userEvent.setup(), base=doubles.invoke.getMockImplementation()!, originalListen=doubles.listen.getMockImplementation()!;
    const resize=globalThis.ResizeObserver;
    Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
    globalThis.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
    let changed:(()=>void)|undefined, recording=false, failure=false, revision=1;
    const snapshot=()=>({epoch:1,revision,connected:true,entries:{bag_record:{sequence:revision,value:{recording,pid:recording?42:0,outputPath:"bags/test",message:"observed"},error:failure?"SSH unavailable":null,age_ms:0,ttl_ms:8000}}});
    doubles.listen.mockImplementation((name,handler)=>{if(name==="native-observations-changed")changed=()=>handler({payload:null});return originalListen(name,handler);});
    doubles.invoke.mockImplementation((command,args)=>{
      if(command==="workspace_snapshot")return Promise.resolve({selected:"motion",pages:{motion:{ready:true,visible:true,detached:true}}});
      if(command==="native_bridge_context")return Promise.resolve({epoch:1,connected:true,profile:defaultProfile,error:null});
      if(command==="native_task_snapshot")return Promise.resolve(null);
      if(command==="native_observation_snapshot")return Promise.resolve(snapshot());
      if(command==="start_rosbag_recording")return Promise.resolve({recording:false,pid:0,outputPath:"",message:"command returned"});
      if(command==="native_observation_refresh") {recording=true;revision++;return Promise.resolve(snapshot());}
      return base(command,args);
    });
    const view=render(<App hostedPage="motion" />);
    try {
      await user.click(await screen.findByRole("button",{name:"更多工具"}));
      const start=await screen.findByRole("button",{name:/开始录制/});
      await waitFor(()=>expect(start).toBeEnabled());await user.click(start);
      expect(await screen.findByRole("button",{name:/停止录制/})).toBeEnabled();
      expect(doubles.invoke).toHaveBeenCalledWith("native_observation_refresh",{source:"bag_record",epoch:1,afterPending:true});
      expect(doubles.invoke).not.toHaveBeenCalledWith("get_rosbag_status",expect.anything());
      expect(doubles.invoke).not.toHaveBeenCalledWith("get_rosbag_play_status",expect.anything());
      failure=true;revision++;await act(async()=>changed!());
      expect(await screen.findByRole("button",{name:/录制状态待确认/})).toBeDisabled();
    } finally {view.unmount();delete (window as unknown as Record<string,unknown>).__TAURI_INTERNALS__;globalThis.ResizeObserver=resize;doubles.invoke.mockImplementation(base);doubles.listen.mockImplementation(originalListen);}
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
    const interval = within(settingsDialog).getByLabelText("Topics 自动刷新间隔（秒）");
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
    expect(await screen.findByLabelText("ROS Topic Graph")).toBeVisible();
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
      await user.click(screen.getByRole("button", { name: /启动所选模式|切换模式（先回零）/ }));
      await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({ mode: "teleop" })));
      await waitFor(() => expect(screen.getByRole("button", { name: "Teleop" })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: "回零并退出控制" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "回零并退出控制" })).toBeEnabled());
    }
    expect(doubles.invoke.mock.calls.filter(([command, args]) => command === "start_arm_mode" && args.mode === "teleop")).toHaveLength(5);
    expect(doubles.invoke.mock.calls.filter(([command, args]) => command === "start_arm_mode" && args.mode === "stop")).toHaveLength(5);
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command" }));
    expect(doubles.send).not.toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command" }));
  });

  it("refuses VLA activation if clean environment initialization fails", async () => {
    localStorage.removeItem("easy-debug-navigate-status-on-connect");
    const implementation = doubles.invoke.getMockImplementation()!;
    doubles.invoke.mockImplementation((command: string, args: unknown) => command === "start_arm_mode"
      ? Promise.resolve({ok: false, exitCode: 1, message: "旧进程未退出", detail: "cleanup refused"})
      : implementation(command, args));
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", {name: "连接 Jetson"}));
    await screen.findByRole("heading", {name: "Status"});
    await user.click(screen.getByRole("tab", {name: /控制模式/})); emitRosReady();
    await user.click(screen.getByRole("button", {name: "VLA"}));
    await user.click(screen.getByRole("button", {name: /启动所选模式|切换模式（先回零）/}));
    await waitFor(() => expect(screen.getByText(/旧进程未退出：cleanup refused/)).toBeVisible());
    expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({mode: "vla"}));
    expect(doubles.invoke.mock.calls.some(([command]) => command === "switch_ros_controllers")).toBe(false);
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({op: "joint_command"}));
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
      await user.click(screen.getByRole("button", { name: /启动所选模式|切换模式（先回零）/ }));
    expect(screen.getByRole("button", { name: "切换中…" })).toBeDisabled();
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
    await user.click(screen.getByText("直接关闭输出…"));
    await user.click(screen.getByRole("button", { name: "直接解除电机输出" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(doubles.invoke).not.toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({ mode: "disable-stop" }));
    await user.click(screen.getByRole("button", { name: "直接解除电机输出" }));
    await user.click(screen.getByRole("checkbox", { name: "机械臂已支撑，可以解除输出" }));
    await user.click(screen.getByRole("button", { name: "确认 DISABLE 并停止" }));
    await waitFor(() => expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode", expect.objectContaining({ mode: "disable-stop" })));
    expect(doubles.request).not.toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command" }));
  });

  it("discards arm workflow events and errors after reconnect", async () => {
    localStorage.removeItem("easy-debug-navigate-status-on-connect");
    const implementation = doubles.invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    let channel!: { onmessage: (event: unknown) => void };
    doubles.invoke.mockImplementation((command: string, args: unknown) => command === "start_arm_mode"
      ? new Promise((resolve) => { finish = resolve; channel = (args as {onProgress: typeof channel}).onProgress; }) : implementation(command, args));
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", {name: "连接 Jetson"}));
    await screen.findByRole("heading", {name: "Status"});
    await user.click(screen.getByRole("tab", {name: /控制模式/})); emitRosReady();
    await user.click(screen.getByRole("button", {name: /启动所选模式|切换模式（先回零）/}));
    await user.click(screen.getByRole("button", {name: /断开并重连…/}));
    await screen.findByRole("button", {name: "连接 Jetson"});
    await user.click(screen.getByRole("button", {name: "连接 Jetson"}));
    await screen.findByRole("heading", {name: "Status"});
    await act(async () => {
      channel.onmessage({stage: "cleanup", message: "old progress", failed: true});
      finish({ok: false, message: "old session failure", detail: "old failure"});
    });
    await user.click(screen.getByRole("tab", {name: /控制模式/}));
    expect(screen.queryByText(/old session failure|old progress/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("控制器启动流程")).not.toBeInTheDocument();
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
    doubles.controllers.mockImplementation(() => {return Promise.resolve({
        manager: "/controller_manager", fresh: true, available: true, controllers: [], message: "",
      });});
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

  it("opens saved positions from the connect page and from the center tab", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "管理姿态库" }));
    expect(screen.getByRole("article", { name: "HOME" })).toBeVisible();
    expect(screen.getByText("待同步")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "返回连接" }));
    await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "Motion" }));
    await user.click(await screen.findByRole("tab", { name: "姿态库" }));
    expect(screen.getByRole("region", { name: "姿态库" })).toBeVisible();
    expect(screen.getByRole("article", { name: "HOME" })).toBeVisible();
  });

  it("opens action group editing offline and returns without connecting", async () => {
    const user = userEvent.setup(); render(<App />);
    await user.click(screen.getByRole("button", { name: "管理动作组" }));
    expect(await screen.findByRole("region", { name: "动作组编辑器" })).toBeVisible();
    expect(screen.getByRole("button", { name: "执行前检查" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "返回连接" }));
    expect(screen.getByRole("button", { name: "连接 Jetson" })).toBeVisible();
    expect(doubles.connect).not.toHaveBeenCalled();
  });

  it("runs a stored action group and retains its owner/stop controls across navigation", async () => {
    localStorage.setItem("easy-debug-profile", JSON.stringify({ host: "group-robot", username: "operator", sshPort: 22 }));
    const group: MotionGroup = { id: "group-1", name: "装配动作", note: "", preparationDuration: 2, createdAt: 0, updatedAt: 0,
      steps: [0, 1].map(index => ({ id: `frame-${index}`, positionId: `pose-${index}`, positionName: index ? "B" : "A", positionUpdatedAt: 0, positions: [0, -.2, -.3, 0, 0, .1 * index], duration: index ? 5 : 0, hold: 0 })) };
    const baseInvoke = doubles.invoke.getMockImplementation()!;
    doubles.controllers.mockImplementation(() => {return Promise.resolve({ manager: "/controller_manager", fresh: true, available: true,
        controllers: [{ name: "arm_trajectory_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "active" }], message: "" });});
    doubles.invoke.mockImplementation((command, args) => {
      if (command === "editor_document_read" && args?.key === "motion_groups") return Promise.resolve({revision: 0, content: JSON.stringify({ schemaVersion: 1, profiles: { "group-robot|operator|22": { groups: [group] } } })});

      return baseInvoke(command, args);
    });
    doubles.request.mockImplementation(async (message) => message.op === "position_motion_info"
      ? { op: message.op, available: true, busy: false, motion_group_supported: true, motion_duration_supported: true }
      : { op: `${message.op}_ack`, accepted: true, command_id: message.command_id });
    try {
      const user = userEvent.setup(); render(<App />);
      await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
      await user.click(await screen.findByRole("button", { name: "Motion" }));
      await user.click(screen.getByRole("tab", { name: "动作组" }));
      expect(await screen.findByRole("region", { name: "动作组编辑器" })).toBeVisible();
      await user.click(screen.getByRole("checkbox", { name: /允许机械臂及夹爪运动/ }));
      const start = screen.getByRole("button", { name: "执行前检查" });
      await waitFor(() => expect(start).toBeEnabled()); await user.click(start);
      await user.click(screen.getByRole("button", { name: "确认并执行" }));
      const request = doubles.request.mock.calls.find(([message]) => message.op === "position_group_start")![0];
      expect(request).toMatchObject({ group_id: "group-1", preparation_duration_s: 2, steps: [{ motion_duration_s: 0 }, { motion_duration_s: 5 }] });
      act(() => doubles.listener?.({ op: "position_motion", command_id: request.command_id, label: group.name, motion_phase: "waiting", group_id: group.id, group_index: 1, group_count: 2, group_phase: "holding", group_elapsed_s: 5.5 }));
      await user.click(screen.getByRole("button", { name: "Topics" }));
      const task = screen.getByRole("status", { name: "当前运动任务" }); expect(task).toHaveTextContent(group.name);
      await user.click(within(task).getByRole("button", { name: "返回 Motion" }));
      expect(screen.getByRole("tab", { name: "动作组" })).toHaveAttribute("aria-selected", "true");
      await user.click(screen.getByRole("button",{name:"专注模式"}));
      expect(screen.getByRole("status",{name:"当前运动任务"})).toBeVisible();
      expect(within(screen.getByRole("status",{name:"当前运动任务"})).getByRole("button",{name:"取消运动"})).toBeVisible();
      expect(screen.getByRole("button",{name:"退出专注"})).toBeVisible();
      await user.click(screen.getByRole("button", { name: "停止动作组" }));
      expect(doubles.request).toHaveBeenCalledWith({ op: "position_cancel", command_id: request.command_id }, 5000);
    } finally { doubles.request.mockResolvedValue({ op: "joint_command_ack", sequence: 1 }); }
  });

  it("dispatches saved positions through MoveIt and captures fresh monotonic feedback", async () => {
    const baseInvoke = doubles.invoke.getMockImplementation()!;
    doubles.controllers.mockImplementation(() => {return Promise.resolve({ manager: "/controller_manager", fresh: true, available: true,
        controllers: [{ name: "arm_trajectory_controller", typeName: "joint_trajectory_controller/JointTrajectoryController", state: "active" }], message: "" });});
    doubles.invoke.mockImplementation((command, args) => {

      return baseInvoke(command, args);
    });
    doubles.request.mockImplementation(async (message: { op: string; command_id?: string }) => {
      if (message.op === "position_motion_info") return { op: message.op, available: true, home_positions: [0, -.01, -.01, 0, 0, 0], busy: false };
      if (message.op === "position_move") return { op: "position_move_ack", command_id: message.command_id };
      return { op: "subscribed" };
    });
    try {
      const user = userEvent.setup(); render(<App />);
      await user.click(screen.getByRole("button", { name: "连接 Jetson" }));
    await user.click(await screen.findByRole("button", { name: "Motion" }));
      await screen.findByRole("tab", { name: "姿态库" });
      act(() => doubles.listener?.({ op: "topic_message", topic: "/stm32/joint_states", data: { name: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"], position: [0, -.2, -.3, 0, 0, 0] } }));
      await user.click(screen.getByRole("tab", { name: "Robot View" }));
      expect(screen.getByRole("button", { name: "保存当前姿态" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "保存当前姿态" }));
      act(() => doubles.listener?.({ op: "topic_message", topic: "/stm32/joint_states", data: { name: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"], position: [1,1,1,1,1,1] } }));
      await user.click(screen.getByRole("button", { name: "保存点位" }));
      expect(screen.queryByRole("dialog", {name:"保存当前姿态"})).not.toBeInTheDocument();
      expect(doubles.request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
      await user.click(screen.getByRole("tab", { name: "姿态库" }));
      expect(screen.queryByRole("button", {name:"手动新增"})).not.toBeInTheDocument();
      expect(screen.queryByRole("button", {name:"启动 MoveIt"})).not.toBeInTheDocument();
      await user.click(screen.getByRole("checkbox", { name: /允许点位运动/ }));
      const move = screen.getByRole("button", { name: "移动到 姿态 1" });
      await waitFor(() => expect(move).toBeEnabled());
      await user.click(move);
      expect(doubles.request.mock.calls.some(([m]) => m.op === "position_move")).toBe(false);
      await user.dblClick(move);
      expect(doubles.request).toHaveBeenCalledWith(expect.objectContaining({ op: "position_move", positions: [0, -.2, -.3, 0, 0, 0], confirmation: "ARMED" }), 5000);
      expect(doubles.request.mock.calls.some(([m]) => m.op === "trajectory_command")).toBe(false);
      const moveRequest = doubles.request.mock.calls.find(([m]) => m.op === "position_move")![0];
      await user.click(screen.getByRole("button", { name: "Topics" }));
      const task = screen.getByRole("status", {name:"当前运动任务"});
      expect(task).toHaveTextContent("姿态 1");
      expect(screen.getByRole("main", {name:"Topics"})).toBeVisible();
      await user.click(within(task).getByRole("button", {name:"取消运动"}));
      expect(doubles.request).toHaveBeenCalledWith({op:"position_cancel",command_id:moveRequest.command_id},5000);
    } finally { doubles.request.mockResolvedValue({ op: "joint_command_ack", sequence: 1 }); }
  });


  it("keeps stale Controller rows read-only and hides Robot View controller readiness",async()=>{
    doubles.controllers.mockResolvedValue({op:"controllers_info",supported:true,manager:"/controller_manager",available:false,fresh:false,has_snapshot:true,snapshot_sequence:1,snapshot_age_ms:3500,snapshot_time_ms:Date.now(),query_state:"timeout",query_pending:false,retry_after_ms:1000,request_wait_ms:0,controllers:[{name:"arm_trajectory_controller",type_name:"joint_trajectory_controller/JointTrajectoryController",state:"active"}],message:"ListControllers >2s"});
    const user=userEvent.setup();render(<App/>);await user.click(screen.getByRole("button",{name:"连接 Jetson"}));
    const list=await screen.findByRole("region",{name:"ROS Control Controllers"});expect(list).toHaveTextContent("查询超时");expect(list).not.toHaveTextContent("离线");expect(list).toHaveTextContent("active（上次）");
    await user.click(screen.getByRole("button",{name:"Motion"}));expect(screen.getByTestId("trajectory-controller")).toHaveTextContent("none");
    await user.click(screen.getByRole("button",{name:"面板"}));await user.click(screen.getByRole("button",{name:"展开 Controllers"}));
    expect(screen.getByRole("button",{name:"停用 arm_trajectory_controller"})).toBeDisabled();
    expect(doubles.invoke.mock.calls.some(([command])=>command==="check_ros_controllers")).toBe(false);
  });
  it("requires a supported Bridge before native mode startup while preserving safe stop",async()=>{
    const connect=doubles.connect.getMockImplementation()!;
    doubles.connect.mockResolvedValue({bridge_version:"0.1.0",bridge_build_id:EXPECTED_BRIDGE_BUILD_ID,ros_distro:"humble",controllers_info_supported:false});
    try{
      const user=userEvent.setup();render(<App/>);await user.click(screen.getByRole("button",{name:"连接 Jetson"}));
      expect(await screen.findByText(/当前 Bridge 不支持常驻 Controller 查询/)).toBeVisible();
      await user.click(screen.getByRole("button",{name:"Status"}));await user.click(screen.getByRole("tab",{name:/控制模式/}));emitRosReady();
      await user.click(screen.getByRole("button",{name:"启动所选模式"}));
      await waitFor(()=>expect(screen.getByRole("button",{name:"Teleop"})).toBeEnabled());
      expect(doubles.invoke.mock.calls.some(([command,args])=>command==="start_arm_mode"&&args.mode==="teleop")).toBe(false);
      expect(doubles.controllers).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button",{name:"回零并退出控制"}));
      await waitFor(()=>expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode",expect.objectContaining({mode:"stop"})));
    }finally{doubles.connect.mockImplementation(connect);}
  });
  it("permits controlled cold-stack recovery and confirms fresh controllers after native startup",async()=>{
    let started=false;const base=doubles.invoke.getMockImplementation()!;
    doubles.controllers.mockImplementation(()=>({manager:"/controller_manager",available:started,controllers:started?[{name:"arm_teleop_controller",typeName:"test/Controller",state:"active"}]:[],message:started?"":"等待 Controller Manager 启动"}));
    doubles.invoke.mockImplementation((command,args)=>{if(command==="start_arm_mode"&&args.mode==="teleop")started=true;return base(command,args);});
    const user=userEvent.setup();render(<App/>);await user.click(screen.getByRole("button",{name:"连接 Jetson"}));await user.click(screen.getByRole("button",{name:"Status"}));await user.click(screen.getByRole("tab",{name:/控制模式/}));emitRosReady();
    expect(screen.getByTestId("current-control-mode")).toHaveTextContent("待确认");
    await user.click(screen.getByRole("button",{name:"启动所选模式"}));
    await waitFor(()=>expect(screen.getByTestId("current-control-mode")).toHaveTextContent("Teleop"));
    expect(doubles.controllers.mock.calls.filter(([message])=>message.refresh===true).length).toBeGreaterThanOrEqual(2);
    expect(doubles.invoke).toHaveBeenCalledWith("start_arm_mode",expect.objectContaining({mode:"teleop"}));
    expect(doubles.invoke.mock.calls.some(([command])=>command==="check_ros_controllers")).toBe(false);
  });
  it("does not claim native mode startup is confirmed when the post-query is unavailable",async()=>{
    doubles.controllers.mockResolvedValue({manager:"/controller_manager",available:false,controllers:[],message:"Manager 暂不可用"});
    const user=userEvent.setup();render(<App/>);await user.click(screen.getByRole("button",{name:"连接 Jetson"}));await user.click(screen.getByRole("button",{name:"Status"}));await user.click(screen.getByRole("tab",{name:/控制模式/}));emitRosReady();
    await user.click(screen.getByRole("button",{name:"启动所选模式"}));
    expect(await screen.findByText(/模式启动后 Controller 状态未确认/)).toBeVisible();
    expect(screen.getByTestId("current-control-mode")).toHaveTextContent("待确认");
  });


it("uses a compact Motion header with icon navigation, recoverable panels and tools",async()=>{
  const user=userEvent.setup(),view=render(<App/>);await user.click(screen.getByRole('button',{name:'连接 Jetson'}));await user.click(await screen.findByRole('button',{name:'Motion'}));
  expect(view.container.querySelector('.app-shell')).toHaveClass('nav-icons');
  expect(screen.queryByRole('toolbar',{name:'应用工具栏'})).not.toBeInTheDocument();
  expect(screen.queryByRole('banner',{name:'已连接工具条'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'刷新全部状态'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'更多工具'}));expect(screen.getByRole('button',{name:'刷新全部状态'})).toBeVisible();
  await user.keyboard('{Escape}');await user.click(screen.getByRole('button',{name:'连接与运动状态'}));expect(screen.getByRole('button',{name:'连接配置'})).toBeVisible();
  await user.keyboard('{Escape}');await user.click(screen.getByRole('button',{name:'面板'}));await user.click(screen.getByRole('button',{name:'展开 Controllers'}));
  expect(screen.getByRole('region',{name:'Controller 管理'})).toBeVisible();
  await user.click(screen.getByRole('button',{name:'专注模式'}));expect(view.container.querySelector('.app-shell')).toHaveClass('motion-focus');
  expect(screen.getByLabelText('Motion Controllers')).not.toBeVisible();
  await user.click(screen.getByRole('button',{name:'退出专注'}));expect(screen.getByRole('region',{name:'Controller 管理'})).toBeVisible();
  expect(view.container.querySelector('.app-shell')).toHaveClass('nav-icons');
});

});
