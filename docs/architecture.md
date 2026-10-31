# Architecture

Product name: **Rebotarm Debug Desk** · repository: [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk).

The npm package is `rebotarm-debug-desk`; Tauri `productName` / window title / `/Applications` install still ship as **Robot Console** (`Robot Console.app`) until a separate code rename.

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
8. Inspector requests `topic_info` / `node_info` from Bridge on demand. The Bridge reads current ROS graph endpoint metadata, including GID and QoS, without running remote CLI commands. Monitor Panels accept numeric fields picked from Inspector, including multiple fields per Panel; time-series charts plot a 30s sliding window, while bar, pie, and gauge charts use the latest value per field.
9. The Bridge uses installed ROS 2 type support to decode unfamiliar message types into nested JSON. Inspector shows the resulting fields (and compact metadata plus Canvas preview for Image topics, which retain their binary transport).
10. Tauri polls `ros2 control list_controllers -c /controller_manager` over SSH every 30 seconds and shows controller names, types and states below Topics.
11. With an active `JointTrajectoryController`, the desktop subscribes to its `~/controller_state` (or legacy `~/state`) and uses the reported `joint_names` as the command contract. The Robot View enables its TCP handle after receiving valid controller joints. A drag solves position-only IK against a stable URDF tool frame; releasing it checks fresh JointState/controller feedback and publishes a matching `trajectory_msgs/JointTrajectory` to `~/joint_trajectory` through the Bridge. Unrelated gripper feedback joints are excluded. The Bridge ACK confirms publication, not controller acceptance or completed motion.
12. Global toolbar operations that need host access bypass the WebSocket Bridge: Tauri runs a fixed, validated SSH command to start/stop `ros2 bag record -a`, while diagnostics snapshots are assembled in the WebView and written through a size- and extension-checked Rust command.
13. Data Collection uses the Tauri `data_collection_action` command over SSH. A bundled Python adapter starts the installed `rebotarm_vla.lerobot_recorder` with the configured Jetson LeRobot Python, calls its fixed Trigger services using the system ROS Python, and tracks the launched PID plus Linux process start identity. Dataset images, videos and parquet files stay on the Jetson. The adapter does not publish robot commands or change controllers; finishing signals only its matching recorder and allows it to finalize normally.
14. Native arm-mode operations stream allowlisted lifecycle stage markers from the fixed SSH script through a per-call Tauri IPC Channel. The UI binds each stream to its operation and connection generation; it never derives completed stages from elapsed time. Control-log visibility uses per-application-process, per-SSH-profile byte baselines for all allowlisted files. The Jetson reader validates file identity and a boundary digest to distinguish append from truncation/replacement; restarting the desktop resets the visible session without deleting remote logs. Log initialization is not a prerequisite for stopping or disabling hardware.

## URDF assets

Robot View 的单关节操作使用独立角度预览状态；模型拾取沿 mesh 的 URDF link/joint 祖先寻找最近的非 mimic 旋转关节。预览只覆盖所选关节，其他关节继续消费反馈。确认执行复用 `position_move` 的 MoveIt 会话流程，Bridge 从本机 ROS 新鲜反馈生成完整六轴目标，并对其余五轴添加路径保持约束；桌面不发送直接 MIT 命令，也不绕过 MoveIt 碰撞检查。能力标志及请求字段见协议。

The URDF XML remains a ROS Topic payload. For each `package://` URI, the desktop requests the resource from the Bridge. The Bridge resolves the package with `ament_index_cpp`, lexically checks that the requested relative path stays inside the package before following resource symlinks, and returns raw bytes in an `RCR1` WebSocket binary response when `encoding: "binary"` is requested. Requests without encoding retain the Base64 JSON response. Each file is limited to 64 MiB. This preserves traversal protection while supporting ROS 2 `--symlink-install`. The desktop creates temporary blob URLs for Three.js. Relative Collada textures are fetched and rewritten before loading.

The desktop retains one parsed Robot View scene (including camera/controls) after its first visit across both center tabs and main navigation. Hidden views stop their R3F frame loop and cancel TCP drags; incomplete loads are aborted instead of retained. Mesh and texture loading must finish before the scene is published. A connection-scoped 128 MiB LRU caches completed resource bytes and deduplicates concurrent requests. Each consumer can cancel independently; the last cancellation removes its pending request, timeout and listeners, stops subsequent resource requests, and rejects obsolete results. Already-sent server reads are not interrupted. Failed or oversized cache entries are not retained. Disconnect/reconnect clears the cache and scene; changing URDF releases old geometry/materials/textures and Blob URLs. Resource modifications at the same URI become visible after reconnect.

Image subscriptions have per-WebSocket interests and are released by `unsubscribe` or disconnect. Only interested clients receive pixels; the ROS subscription is dropped after its last interested client leaves. The desktop leases the selected image only while the Topics Inspector data view is visible and live updates are enabled. Collapsed panels, other navigation pages, details views and hidden windows release that lease. Non-image subscriptions retain the existing shared broadcast behavior.

Robot View's left-arm wrist RGBD preview uses a separate Bridge session and the `/cameras/left_arm/wrist/` namespace. The native one-click camera action launches the robot stack's `rebotarm_gazebo/left_wrist_camera.launch.py`; that launch starts the RealSense wrapper with aligned depth and sync plus an identity TF from the URDF's `camera_link` to `left_arm/wrist_link`. The robot stack's real-arm launch feeds `robot_state_publisher` from `/stm32/joint_states`, the same joint feedback used by Robot View, so `base_link ← camera_link` remains current when ros2_control's `/joint_states` has stale positions. A camera driver installed under another namespace or without aligned depth will not produce complete preview frames; Robot View hides its old cloud after a sustained TF failure.


## Bridge deployment

Agents and developers should deploy the Jetson package with `npm run deploy:bridge` (`scripts/deploy-bridge.mjs`) rather than ad-hoc SSH copy steps. The script syncs into `<remote>/src/easy_debug_bridge/` (remote workspace defaults to `easy_debug_bridge` resolved against the remote user's `$HOME`; override with an absolute or `$HOME`-relative path via `--remote` / `$BRIDGE_DEPLOY_REMOTE`; `.`/`..`/`~` segments are rejected), runs `colcon build --symlink-install --packages-select easy_debug_bridge` after sourcing Humble and the robot overlay, then checks the resolved `bridge_node` and loopback listener. Restarting the process that owns `127.0.0.1:8765` requires an explicit `--restart` flag. Desktop `start_session` remains responsible for day-to-day Bridge bring-up over SSH once the install tree is current.

## Current limits

- One desktop session profile at a time.
- Non-image Bridge subscriptions are shared by all connected WebSocket clients; Image delivery is scoped to interested clients.
- Message decoding uses an explicit standard-type registry.
- Mesh transfer uses a complete binary response held in memory (legacy Base64 remains supported). Compression, chunked streaming and disk caching are not implemented.
- Monitor provides live numeric charts and Jetson-side `ros2 bag play` (SSH); downloading, indexing and client-side bag parsing remain follow-up work. TF visualization is not part of this vertical slice. The toolbar can record all topics on the Jetson.
- Topic Graph can visualize every discovered type. Inspector detail queries read ROS graph metadata; live data viewing requires the corresponding message type support in the Bridge ROS environment.
- ROS Control targets `/controller_manager` and supports controller Activate/Deactivate. Trajectory commands only reach the active `JointTrajectoryController`'s `~/joint_trajectory` topic; the Bridge rejects any other topic.
- TCP dragging solves position only and keeps the end-effector orientation fixed.

## Status log reader

Status has four health-summary tabs. The control tab reads allowlisted Jetson text logs through native Tauri commands (`read_control_log` / `download_control_log`) over authenticated SSH; logs do not pass through the ROS Bridge or DDS. The native reader chooses fixed cache files or the latest `ros2_control_node_*.log`, checks the resolved directory boundary and regular-file type, and limits tail reads to 128 KiB / 2000 lines and complete downloads to 32 MiB. SSH reads time out locally after 15 seconds and remotely after 10 seconds. Hidden tabs/windows stop scheduling reads and discard pending replies; downloads use a user-selected local `.log` path. No new network listener or motor command is introduced. Log baselines live only in the native application process and span all allowlisted sources for the selected SSH profile. Managed startup files are moved intact into a sibling `history/` directory before a new writer starts, so restart detection does not depend on text differences. Controller log selection follows the pending target during startup and the verified active mode afterward.

## Console-managed ROS transport

The installed Bridge package includes `config/fastdds_udp.xml`. Native SSH commands and the deployment restart script select this UDPv4-only Fast DDS participant default when neither `FASTRTPS_DEFAULT_PROFILES_FILE` nor `FASTDDS_DEFAULT_PROFILES_FILE` is explicitly set. The profile is scoped to the launched process and inherited children; SSH/WebSocket boundaries and ROS domain selection stay the same. No active SHM files are unlinked and no system daemon/service configuration is rewritten. The ROS stack Teleop entry owns its corresponding default and leader shutdown adapter.

This handles environments where long-lived participants retain deleted SHM lock inodes and no longer share the same discovered graph as new processes. Explicit deployment profiles take precedence. UDP can have different CPU/bandwidth characteristics for large camera images; deployments with repaired SHM can select their own profile. XML transport configuration follows the [Fast DDS 2.6 UDP transport documentation](https://fast-dds.docs.eprosima.com/en/v2.6.11/fastdds/transport/udp/udp.html).

Graph filtering is a presentation preference: only the desktop diagnostic Bridge is hidden by default. Hardware/ROS bridge nodes and their endpoint relations remain visible.

## 保存位置与 MoveIt2

位置卡片通过 Bridge 的 `position_motion_info` / `position_move` / `position_cancel` 操作连接 Jetson 的固定 `arm` 组和 `/move_action`，MoveIt 使用当前 Planning Scene 规划并通过唯一允许的真实 JTC Action 执行，不经过桌面的两点 IK 路径。实现独立在 `position_motion.cpp`，无 MoveIt 消息依赖的构建保留只读/管理功能并返回 unavailable。Mac 不加入 DDS。

Bridge 将 WebSocket 请求排队到 ROS executor 的互斥回调组，管理全局单运动所有权、去重、实时门禁和取消 watchdog；会话释放会取消其拥有的 goal。模型与 HOME 来自实际 `/move_group` 参数而非本机文件。端侧从 Action 结果与新鲜关节停稳反馈确认终态。管理数据保存在本机，运动使用点击时的目标快照；编辑/删除只改变后续请求。

控制栈的 `real_move_group.launch.py` 只启动规划器，不创建第二个硬件/RSP/ControllerManager。现场启停与电机确认继续沿用原流程。新路径不会放宽旧 `trajectory_command` 的 Topic 白名单或 64 点上限；完整 MoveIt 轨迹留在 Jetson，由 MoveIt 执行栈管理。


## MoveIt 规划器进程

`start_arm_mode` 的 `moveit` 操作通过固定原生 SSH 命令启动真实 `real_move_group.launch.py`。Trajectory 使用同一规划器管理逻辑；Mac 不加入 DDS，WebView 不提交任意 shell 命令。原生 helper 在目标域核验 Action、参数与 Planning Scene 服务，保存本应用创建的进程身份。arm 模式互斥锁覆盖规划器启动与退出，DISABLE 后才清理受管理规划器；外部规划器只读探测并复用。日志沿用本机会话游标与 SSH 路径，不改变 WebSocket 协议、Bridge 构建 ID 或运动执行白名单。
