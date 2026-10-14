# Architecture

Product name: **Robot Debug Desk** · repository: [`phamstered/robot-debug-desk`](https://github.com/phamstered/robot-debug-desk).

The npm package remains `easy-debug`; Tauri `productName` / window title / `/Applications` install still ship as **Robot Console** (`Robot Console.app`) until a separate code rename.

## 系统架构 · System architecture

桌面端通过 **SSH 隧道** 访问 Jetson 上只监听 `127.0.0.1` 的 WebSocket Bridge；**Mac 从不直接加入 DDS**。SSH 提供认证、主机密钥校验与传输加密。

<SystemArchitecture />

## 数据流 · Data flow

遥测（Topics / HardwareStatus / JointState）经 Bridge 进入 App；控制（`joint_command` / `trajectory_command`）经 Bridge 下发到 ROS，并返回 ACK。断开连接时若电机命令流仍在运行，先请求 **DISABLE**。

<DataFlowDiagram />

字段与操作语义见 [Bridge 协议](./protocol)。

## Data path（文字说明）

1. React / Three.js UI 通过 Tauri `invoke` 驱动 Rust SSH session manager。
2. Rust 建立本地端口转发：本机端口 → Jetson `127.0.0.1:8765`。
3. WebView 连接本地转发端口上的 WebSocket。
4. Jetson 上的 `easy_debug_bridge`（C++ / Boost.Beast / rclcpp）接入 ROS 2 Humble graph（含 Micro XRCE-DDS Agent 暴露的实体）。

## Connection sequence

1. Desktop checks `ssh` in batch mode.
2. Desktop sources `/opt/ros/humble/setup.bash`, the configured robot overlay, and the Bridge overlay.
3. Desktop starts the Bridge if its configured loopback port is not listening.
4. Desktop starts `ssh -N -L` local forwarding.
5. WebView opens a WebSocket to the local forwarded port.
6. UI requests Topic discovery and the node/topic endpoint graph, then subscribes to URDF and JointState topics.
7. Topic Graph applies a deterministic force layout before rendering publisher → topic → subscriber SVG edges. A Node is a rounded rectangle and a Topic is an ellipse. Selecting a Topic creates a read-only Bridge subscription and focuses the graph; selecting a Node opens its details in Inspector.
8. Inspector requests `topic_info` / `node_info` from Bridge on demand. The Bridge reads current ROS graph endpoint metadata, including GID and QoS, without running remote CLI commands. DataGraph in Monitor plots numeric fields picked from Inspector over a 30s sliding window; v1 is single-topic multi-field (arrays expand to series).
9. The Bridge uses installed ROS 2 type support to decode unfamiliar message types into nested JSON. Inspector shows the resulting fields (and compact metadata plus Canvas preview for Image topics, which retain their binary transport).
10. Tauri polls `ros2 control list_controllers -c /controller_manager` over SSH every 30 seconds and shows controller names, types and states below Topics.
11. With an active `JointTrajectoryController`, the Robot View shows a draggable TCP handle. A drag solves position-only IK against the URDF joint chain; releasing it publishes `trajectory_msgs/JointTrajectory` to the controller's `~/joint_trajectory` topic through the Bridge.
12. Global toolbar operations that need host access bypass the WebSocket Bridge: Tauri runs a fixed, validated SSH command to start/stop `ros2 bag record -a`, while diagnostics snapshots are assembled in the WebView and written through a size- and extension-checked Rust command.

## URDF assets

The URDF XML remains a ROS Topic payload. For each `package://` URI, the desktop requests the resource from the Bridge. The Bridge resolves the package with `ament_index_cpp`, lexically checks that the requested relative path stays inside the package before following resource symlinks, and returns base64 bytes. This preserves traversal protection while supporting ROS 2 `--symlink-install`. The desktop creates temporary blob URLs for Three.js. Relative Collada textures are fetched and rewritten before loading.


## Bridge deployment

Agents and developers should deploy the Jetson package with `npm run deploy:bridge` (`scripts/deploy-bridge.mjs`) rather than ad-hoc SSH copy steps. The script syncs into `<remote>/src/easy_debug_bridge/` (remote workspace defaults to `easy_debug_bridge` resolved against the remote user's `$HOME`; override with an absolute or `$HOME`-relative path via `--remote` / `$BRIDGE_DEPLOY_REMOTE`; `.`/`..`/`~` segments are rejected), runs `colcon build --symlink-install --packages-select easy_debug_bridge` after sourcing Humble and the robot overlay, then checks the resolved `bridge_node` and loopback listener. Restarting the process that owns `127.0.0.1:8765` requires an explicit `--restart` flag. Desktop `start_session` remains responsible for day-to-day Bridge bring-up over SSH once the install tree is current.

## Current limits

- One desktop session profile at a time.
- Bridge subscriptions are shared by all connected WebSocket clients.
- Message decoding uses an explicit standard-type registry.
- Mesh transfer is base64 and held in memory; streaming is a later optimization.
- Monitor provides live numeric charts and Jetson-side `ros2 bag play` (SSH); downloading, indexing and client-side bag parsing remain follow-up work. TF visualization is not part of this vertical slice. The toolbar can record all topics on the Jetson.
- Topic Graph can visualize every discovered type. Inspector detail queries read ROS graph metadata; live data viewing requires the corresponding message type support in the Bridge ROS environment.
- ROS Control targets `/controller_manager` and supports controller Activate/Deactivate. Trajectory commands only reach the active `JointTrajectoryController`'s `~/joint_trajectory` topic; the Bridge rejects any other topic.
- TCP dragging solves position only and keeps the end-effector orientation fixed.
