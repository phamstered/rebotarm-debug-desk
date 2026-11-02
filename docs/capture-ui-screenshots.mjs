/**
 * Capture empty-state Desk screenshots for the user docs.
 * Requires `npm run dev` on http://127.0.0.1:1420.
 * Transport replies are empty: no JointState, no point cloud, no USB devices.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "public/screenshots");
const out = (name) => resolve(root, name);

const init = `(() => {
  const BUILD = "869118064256";
  localStorage.clear();
  const reply = (msg) => {
    const id = msg.request_id;
    const base = id ? { request_id: id } : {};
    if (msg.op === "hello") return { op: "hello", bridge_version: "0.1.0", bridge_build_id: BUILD, ros_distro: "humble", controllers_info_supported: true, rgbd_subscription_id_supported: true, ...base };
    if (msg.op === "topics") return { op: "topics", topics: [], ...base };
    if (msg.op === "graph") return { op: "graph", nodes: [], edges: [], ...base };
    if (msg.op === "controllers_info") return { op: "controllers_info", supported: true, manager: "/controller_manager", available: false, fresh: false, has_snapshot: false, snapshot_sequence: 0, query_state: "unavailable", query_pending: false, retry_after_ms: 1000, request_wait_ms: 0, controllers: [], message: "Controller Manager 未响应", ...base };
    if (msg.op === "position_motion_info") return { op: "position_motion_info", available: false, message: "MoveIt /move_action 未启动，请启动 real_move_group.launch.py", home_positions: [], busy: false, ...base };
    if (msg.op === "clock_sync_info") return { op: "clock_sync_info", supported: true, state: "waiting", message: "等待关节反馈", source_topic: "/stm32/joint_states", generation: 0, ...base };
    if (msg.op === "subscribe_rgbd") return { op: "subscribed_rgbd", ...base };
    if (msg.op === "subscribe") return { op: "subscribed", topic: msg.topic, ...base };
    return { op: "error", message: "未知操作：" + (msg.op || ""), ...base };
  };
  class Socket {
    constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 20); }
    send(data) { const msg = JSON.parse(data); const body = reply(msg); setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(body) }), 15); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
  }
  Socket.OPEN = 1; Socket.CONNECTING = 0; Socket.CLOSING = 2; Socket.CLOSED = 3;
  window.WebSocket = Socket;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    invoke: async (cmd) => {
      if (cmd === "check_ssh") return "ready";
      if (cmd === "start_session") return 18765;
      if (cmd === "check_micro_ros_agent") return { loadState: "loaded", activeState: "inactive", subState: "dead", result: "success", mainPid: 0, unitFileState: "disabled", description: "micro-ROS Agent" };
      if (cmd === "probe_jetson_usb") return { mcuPresent: false, mcuVidPid: "", realsensePresent: false, realsenseLines: [], rawLsusb: "" };
      if (cmd === "probe_arm_mode") return { mode: "idle", teleopRunning: false, trajectoryRunning: false, realsenseRunning: false, teleopOwnsRos2Control: false, trajectoryOwnsRos2Control: false, teleopPid: 0, trajectoryPid: 0, realsensePid: 0, message: "" };
      if (cmd === "get_rosbag_status") return { recording: false, pid: 0, outputPath: "", message: "rosbag 当前未录制" };
      if (cmd === "get_rosbag_play_status") return { playing: false, pid: 0, bagPath: "", message: "rosbag 当前未回放" };
      if (cmd === "positions_load" || cmd === "motion_groups_load") return null;
      if (cmd === "read_control_log") return { source: "teleop", path: "", exists: false, content: "", truncated: false, sizeBytes: 0, revision: "" };
      if (cmd === "data_collection_action") return { state: "stopped", managed: false, pid: 0, recording: false, pendingFrames: 0, savedEpisodes: 0, fps: 0, task: "", repoId: "", root: "", message: "", log: "" };
      if (cmd === "stop_session") return null;
      throw new Error("docs-capture: " + cmd);
    },
  };
})();`;

const shot = async (page, name) => {
  await page.screenshot({ path: out(name), animations: "disabled" });
  console.log(name);
};

await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(init);
await page.goto("http://127.0.0.1:1420/", { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Robot Console" }).waitFor();
await shot(page, "connect.png");
await page.getByText("高级", { exact: true }).click();
await page.getByLabel("RGB Topic").waitFor();
await shot(page, "connect-advanced.png");
await page.getByRole("button", { name: "管理姿态库" }).click();
await page.getByRole("region", { name: "姿态库" }).waitFor();
await shot(page, "positions-offline.png");
await page.getByRole("button", { name: "返回连接" }).click();
await page.getByRole("button", { name: "连接 Jetson" }).click();
await page.getByRole("heading", { name: "Status" }).waitFor();
await page.waitForTimeout(400);
await shot(page, "status-connection.png");
await page.getByRole("tab", { name: /硬件健康/ }).click();
await page.getByRole("article", { name: "RealSense" }).waitFor();
await shot(page, "status-hardware.png");
await page.getByRole("tab", { name: /控制模式/ }).click();
await page.getByRole("button", { name: "VLA", exact: true }).waitFor();
await shot(page, "status-vla.png");
await page.getByRole("button", { name: "Motion", exact: true }).click();
await page.getByRole("tab", { name: "Robot View" }).waitFor();
await page.waitForTimeout(500);
await shot(page, "robot-view.png");
await page.getByRole("tab", { name: "姿态库" }).click();
await page.getByRole("region", { name: "姿态库" }).waitFor();
await shot(page, "positions.png");
await browser.close();
console.log("wrote", root);
