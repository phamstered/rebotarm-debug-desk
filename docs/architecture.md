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
3. 安装版由 Rust 会话管理器连接本地转发端口上的 WebSocket，WebView 使用原生 IPC 请求和有界二进制拉取。纯浏览器开发环境保留直接 WebSocket 适配器。
4. Jetson 上的 `easy_debug_bridge`（C++ / Boost.Beast / rclcpp）接入 ROS 2 Humble graph（含 Micro XRCE-DDS Agent 暴露的实体）。

## Connection sequence

1. Desktop checks `ssh` in batch mode.
2. Desktop sources `/opt/ros/humble/setup.bash`, the configured robot overlay, and the Bridge overlay.
3. Desktop starts the Bridge if its configured loopback port is not listening.
4. Desktop starts `ssh -N -L` local forwarding.
5. The native session runtime opens one WebSocket to the actual SSH-forwarded port; the main WebView attaches using its native window identity and connection epoch.
6. UI requests Topic discovery and the node/topic endpoint graph, then subscribes to URDF and JointState topics.
7. Topic Graph applies a deterministic force layout before rendering publisher → topic → subscriber SVG edges. A Node is a rounded rectangle and a Topic is an ellipse. Selecting a Topic creates a read-only Bridge subscription and focuses the graph; selecting a Node opens its details in Inspector.
8. Inspector requests `topic_info` / `node_info` from Bridge on demand. The Bridge reads current ROS graph endpoint metadata, including GID and QoS, without running remote CLI commands. Monitor Panels accept numeric fields picked from Inspector, including multiple fields per Panel; time-series charts plot a 30s sliding window, while bar, pie, and gauge charts use the latest value per field.
   Monitor 的运动误差模板由桌面端从既有 JointState/JTC `topic_message` 计算，`monitor://motion-errors/` 是仅用于图表持久化的本地派生序列，不是 ROS Topic，也不向 Bridge 订阅或发布。控制器源 Topic 在模板存在时订阅，与 Robot View / Inspector 共享至会话断开；诊断不参与运动安全判断。
9. The Bridge uses installed ROS 2 type support to decode unfamiliar message types into nested JSON. Inspector shows the resulting fields (and compact metadata plus Canvas preview for Image topics, which retain their binary transport).
10. The desktop reads `controllers_info` over the existing WebSocket every second. A single persistent Bridge ROS client and cache serve both controller lists and motion health, including builds without MoveIt. Cached reads do not create ROS requests; manual refresh and control pre/post checks wait for a query dispatched after their request. Failure retains timestamped last-success rows for read-only display while invalidating availability and control permission. Topics, Motion and Status share the connection-scoped snapshot; Activate/Deactivate remains Motion-only and uses the existing confirmed native SSH operation followed by a new Bridge verification.
11. Robot View subscribes to the active arm trajectory controller's state and uses its six joint names for local six-dimensional TCP IK preview. Releasing a drag preserves the preview; explicit confirmation submits a root-frame TCP pose through the same Bridge MoveIt state machine used by saved positions and joint adjustment. The optional prismatic gripper is independent of arm IK. Its calibrated metre target is planned as `gripper` or `arm_with_gripper` and executed through the dedicated `gripper_trajectory_controller` plus the arm controller. An ACK confirms admission; completion requires Action success and fresh measured stop/arrival feedback.
   Bridge 的 PositionMotion 独立订阅 JointState Broadcaster `/joint_states`，用于与 arm/gripper JTC actual 的位置一致性检查。该订阅采用与现场 RELIABLE 发布端兼容的 BEST_EFFORT/VOLATILE QoS；源时间和接收时间双重校验，不使用锁存旧帧续期。配置的 STM32 JointState 输入仍用于固件时钟、实测起点、限位及停止/到位验证。Broadcaster 夹爪已经是米制，只有原始 STM32 反馈需要标定换算。两路控制器输出的最新帧不等于严格同周期配对。
12. Global toolbar operations that need host access bypass the WebSocket Bridge: Tauri runs a fixed, validated SSH command to start/stop `ros2 bag record -a`, while diagnostics snapshots are assembled in the WebView and written through a size- and extension-checked Rust command.
13. Data Collection uses the Tauri `data_collection_action` command over SSH. A bundled Python adapter starts the installed `rebotarm_vla.lerobot_recorder` with the configured Jetson LeRobot Python, calls its fixed Trigger services using the system ROS Python, and tracks the launched PID plus Linux process start identity. Dataset images, videos and parquet files stay on the Jetson. The adapter does not publish robot commands or change controllers; finishing signals only its matching recorder and allows it to finalize normally.
14. Native arm-mode operations stream allowlisted lifecycle stage markers from the fixed SSH script through a per-call Tauri IPC Channel. The UI binds each stream to its operation and connection generation; it never derives completed stages from elapsed time. Control-log visibility uses per-application-process, per-SSH-profile byte baselines for all allowlisted files. The Jetson reader validates file identity and a boundary digest to distinguish append from truncation/replacement; restarting the desktop resets the visible session without deleting remote logs. Log initialization is not a prerequisite for stopping or disabling hardware.

## URDF assets

Robot View 的关节调整使用按关节名保存的角度预览；模型拾取选择独立旋转轴，切换所选关节保留其他已编辑目标。确认执行将编辑映射和运动时长发送给 Bridge，未编辑轴继续从 ROS 实测反馈取得，并添加路径保持约束。定时运动先通过 `/move_action` plan-only 碰撞规划，再在 Jetson 校验并重定时轨迹并校验整段样条速度/加速度上界，通过 `/execute_trajectory` 执行完整路径；规划与执行共享取消、断线和运动锁。桌面不直接发布 MIT 或拆分中间点，Mac 不加入 DDS。协议能力标志防止旧 Bridge 静默忽略时长；未指定时长的既有点位请求继续使用原 MoveGroup 执行路径。

The URDF XML remains a ROS Topic payload. For each `package://` URI, the desktop requests the resource from the Bridge. The Bridge resolves the package with `ament_index_cpp`, lexically checks that the requested relative path stays inside the package before following resource symlinks, and returns raw bytes in an `RCR1` WebSocket binary response when `encoding: "binary"` is requested. Requests without encoding retain the Base64 JSON response. Each file is limited to 64 MiB. This preserves traversal protection while supporting ROS 2 `--symlink-install`. The desktop creates temporary blob URLs for Three.js. Relative Collada textures are fetched and rewritten before loading.

The desktop retains one parsed Robot View scene (including camera/controls) after its first visit across both center tabs and main navigation. Hidden views stop their R3F frame loop and cancel TCP drags; incomplete loads are aborted instead of retained. Mesh and texture loading must finish before the scene is published. A connection-scoped 128 MiB LRU caches completed resource bytes and deduplicates concurrent requests. Each consumer can cancel independently; the last cancellation removes its pending request, timeout and listeners, stops subsequent resource requests, and rejects obsolete results. Already-sent server reads are not interrupted. Failed or oversized cache entries are not retained. Disconnect/reconnect clears the cache and scene; changing URDF releases old geometry/materials/textures and Blob URLs. Resource modifications at the same URI become visible after reconnect.

Image subscriptions have per-WebSocket interests and are released by `unsubscribe` or disconnect. Only interested clients receive pixels; the ROS subscription is dropped after its last interested client leaves. The desktop leases the selected image only while the Topics Inspector data view is visible and live updates are enabled. Collapsed panels, other navigation pages, details views and hidden windows release that lease. Non-image subscriptions retain the existing shared broadcast behavior.

Motion / Robot View's left-arm wrist RGBD preview uses a separate Bridge session and the `/cameras/left_arm/wrist/` namespace. The native one-click camera action launches the robot stack's `rebotarm_gazebo/left_wrist_camera.launch.py`; that launch starts the RealSense wrapper with aligned depth and sync plus an identity TF from the URDF's `camera_link` to `left_arm/wrist_link`. The real-arm launch feeds `robot_state_publisher` from clock-guarded `/robot_feedback/tf_joint_states`, while Robot View uses calibrated `/robot_feedback/joint_states`. These paths preserve measured joint positions and keep `base_link ← camera_link` current independently of ros2_control's `/joint_states`.

RGBD reception uses a private ROS context (and therefore a separate DDS participant), an `easy_debug_rgbd_receiver` node and a `SingleThreadedExecutor`. Large image fragments cannot occupy the same DDS ingress as capture-time TF and control feedback. The receiver context inherits the Bridge domain and initialization options; its callback group is excluded from automatic executor registration. Subscription creation and retired-subscription destruction run as queued jobs outside that executor's `spin_some`, avoiding Fast DDS waitset races during unsubscribe. Clients with the same RGB, depth and CameraInfo topic combination share one set of three ROS subscriptions. Receiver callbacks fan shared image references into independent, bounded client queues; preview size, rate, target frame and tokens remain per-client. Each client has a native processing worker; unsubscribe first invalidates and joins that worker, then queues its session for receiver-thread cleanup. The last session releases the shared subscriptions outside executor waits; cancelling one client preserves the others. The cancellation ACK follows all prior frame sends. Three-frame best-effort, volatile RGB and depth queues select the closest bounded-time pair. Image callbacks only receive data; the worker performs nonblocking TF lookups at the image capture timestamp, retrying a pending pair for at most 150 ms. A consumed pair is not reused. Time invalidation, epoch changes, missing streams and encoding errors retain explicit status and recovery behavior.

The older RGB/depth source timestamp must remain within 500 ms at processing/sending. The metadata reports `frame_age_ms` measured on Jetson at packaging, and the desktop subtracts it from its local 500 ms receive lease; unknown SSH/network delay is not represented as a guaranteed end-to-end deadline. Desktop RAF coalescing keeps RGB, depth, intrinsics and pose together, hides the old cloud on an explicit failure, and expires stalled streams using monotonic time. A client-generated `subscription_id`, echoed in ACKs and success/error frames, rejects obsolete subscription data when the Bridge advertises support; legacy Bridges retain interest/configuration filtering without strong same-configuration lease isolation. Bounded WebSocket write deadlines interrupt slow clients without changing Beast framing or blocking the ROS reception executor. A camera driver installed under another namespace or without aligned depth will not produce complete preview frames.


## Bridge deployment

Agents and developers should deploy the Jetson package with `npm run deploy:bridge` (`scripts/deploy-bridge.mjs`) rather than ad-hoc SSH copy steps. The script syncs into `<remote>/src/easy_debug_bridge/` (remote workspace defaults to `easy_debug_bridge` resolved against the remote user's `$HOME`; override with an absolute or `$HOME`-relative path via `--remote` / `$BRIDGE_DEPLOY_REMOTE`; `.`/`..`/`~` segments are rejected), runs `colcon build --symlink-install --packages-select easy_debug_bridge` after sourcing Humble and the robot overlay, then checks the resolved `bridge_node` and loopback listener. Restarting the process that owns `127.0.0.1:8765` requires an explicit `--restart` flag. Desktop `start_session` remains responsible for day-to-day Bridge bring-up over SSH once the install tree is current.

Native deployment resolves Node before launching the fixed repository script: an explicit `NODE_BINARY` wins, followed by the inherited PATH and macOS Homebrew install locations. Invalid explicit overrides fail without fallback. The selected executable is passed directly to the process API, with a child-scoped PATH for helper tools; no login shell or shell startup file is evaluated and no global environment is changed. The existing SSH/deployment stages and loopback-only Bridge listener remain unchanged.

## Current limits

- One desktop session profile at a time.
- Non-image Bridge subscriptions are shared by all connected WebSocket clients; Image delivery is scoped to interested clients.
- Message decoding uses an explicit standard-type registry.
- Mesh transfer uses a complete binary response held in memory (legacy Base64 remains supported). Compression, chunked streaming and disk caching are not implemented.
- Monitor provides live numeric charts and Jetson-side `ros2 bag play` (SSH); downloading, indexing and client-side bag parsing remain follow-up work. TF visualization is not part of this vertical slice. The toolbar can record all topics on the Jetson.
- Topic Graph can visualize every discovered type. Inspector detail queries read ROS graph metadata; live data viewing requires the corresponding message type support in the Bridge ROS environment.
- Motion controller management targets `/controller_manager` and supports confirmed Activate/Deactivate; Topics controller cards stay read-only. Trajectory commands only reach the active `JointTrajectoryController`'s `~/joint_trajectory` topic; the Bridge rejects any other topic.
- TCP dragging retains a center sphere for free translation in a fixed camera-facing plane, alongside independent XYZ translation and axis rotation in base/tool frames. Numeric RPY uses fixed XYZ axes; quaternions carry the target pose. A held target is independent of feedback and of the local IK preview.

## Status log reader

Status has four health-summary tabs. The control tab reads allowlisted Jetson text logs through native Tauri commands (`read_control_log` / `download_control_log`) over authenticated SSH; logs do not pass through the ROS Bridge or DDS. The native reader chooses fixed cache files or the latest `ros2_control_node_*.log`, checks the resolved directory boundary and regular-file type, and limits tail reads to 128 KiB / 2000 lines and complete downloads to 32 MiB. SSH reads time out locally after 15 seconds and remotely after 10 seconds. Hidden tabs/windows stop scheduling reads and discard pending replies; downloads use a user-selected local `.log` path. No new network listener or motor command is introduced. Log baselines live only in the native application process and span all allowlisted sources for the selected SSH profile. Managed startup files are moved intact into a sibling `history/` directory before a new writer starts, so restart detection does not depend on text differences. Controller log selection follows the pending target during startup and the verified active mode afterward.

## Console-managed ROS transport

The installed Bridge package includes `config/fastdds_udp.xml`. Native SSH commands and the deployment restart script select this UDPv4-only Fast DDS participant default when neither `FASTRTPS_DEFAULT_PROFILES_FILE` nor `FASTDDS_DEFAULT_PROFILES_FILE` is explicitly set. The profile is scoped to the launched process and inherited children; SSH/WebSocket boundaries and ROS domain selection stay the same. No active SHM files are unlinked and no system daemon/service configuration is rewritten. The ROS stack Teleop entry owns its corresponding default and leader shutdown adapter.

This handles environments where long-lived participants retain deleted SHM lock inodes and no longer share the same discovered graph as new processes. Explicit deployment profiles take precedence. UDP can have different CPU/bandwidth characteristics for large camera images; deployments with repaired SHM can select their own profile. XML transport configuration follows the [Fast DDS 2.6 UDP transport documentation](https://fast-dds.docs.eprosima.com/en/v2.6.11/fastdds/transport/udp/udp.html).

Graph filtering is a presentation preference: only the desktop diagnostic Bridge is hidden by default. Hardware/ROS bridge nodes and their endpoint relations remain visible.

## 保存位置与 MoveIt2

位置卡片、关节调整与 TCP 确认通过 Bridge 的 `position_motion_info` / `position_move` / `position_cancel` 操作连接 Jetson 的固定 `arm`、`gripper` 或 `arm_with_gripper` 组和 `/move_action`。MoveIt 使用当前 Planning Scene 规划，执行控制器仅允许审核过的 `arm_trajectory_controller` 和可选 `gripper_trajectory_controller`。TCP 本地 6D IK 只提供预览与收敛校验，执行使用完整 Pose 位置/姿态约束，而非本地关节解。Bridge 将稳定 TCP 的固定变换换算为 arm tip 目标，MoveIt plan-only 后再校验 FK 终点、时序和实测起点，通过 ExecuteTrajectory 执行。实现独立在 `position_motion.cpp`，无 MoveIt 消息依赖的构建保留只读/管理功能并返回 unavailable。Mac 不加入 DDS。

Bridge 将 WebSocket 请求排队到 ROS executor 的互斥回调组，管理全局单运动所有权、去重、实时门禁和取消 watchdog；会话释放会取消其拥有的 goal。模型与 HOME 来自实际 `/move_group` 参数而非本机文件。端侧从 Action 结果与新鲜关节停稳反馈确认终态。管理数据保存在本机，运动使用点击时的目标快照；编辑/删除只改变后续请求。

控制栈的 `real_move_group.launch.py` 只启动规划器，不创建第二个硬件/RSP/ControllerManager。现场启停与电机确认继续沿用原流程。新路径不会放宽旧 `trajectory_command` 的 Topic 白名单或 64 点上限；完整 MoveIt 轨迹留在 Jetson，由 MoveIt 执行栈管理。


## MoveIt 规划器进程

`start_arm_mode` 的 `moveit` 操作通过固定原生 SSH 命令启动真实 `real_move_group.launch.py`。Trajectory 使用同一规划器管理逻辑；Mac 不加入 DDS，WebView 不提交任意 shell 命令。原生 helper 在目标域核验 Action、参数与 Planning Scene 服务，保存本应用创建的进程身份。arm 模式互斥锁覆盖规划器启动与退出，DISABLE 后才清理受管理规划器；外部规划器只读探测并复用。日志沿用本机会话游标与 SSH 路径，不改变 WebSocket 协议、Bridge 构建 ID 或运动执行白名单。

## Motion audit and controller health

Clock health compares each raw STM32 JointState stamp with Jetson ROS time; receipt freshness and a 200 ms recovery window use steady time. More than 50 ms in the future, at least one second in the past, zero/invalid stamps, long receipt gaps and clock jumps invalidate admission. Firmware diagnostics v1 retains host timestamp validation; v2 adds explicit synchronization/15-second holdover and epoch state, with a three-second diagnostic receipt deadline. Source stamps are never replaced by arrival time. The read-only `clock_sync_info` API works without MoveIt and the desktop does not compare against Mac wall time.

The MoveIt state machine independently validates source time. A clock epoch change cancels an admitted motion and is checked again immediately before ExecuteTrajectory; invalid-time samples cannot confirm stop/arrival or populate a fresh gripper snapshot. DISABLE and the firmware's monotonic motor watchdog retain their existing paths. RGBD rejects time-invalid pairs and, after recovery, recreates its TF buffer/listener to discard old future transforms and reacquire static transforms. The control stack separately guards normalized feedback and feeds RSP through a bounded TF-only topic so source-time corrections do not leave its publication throttle stuck in an old epoch.

The position-motion state machine uses its own mutually exclusive callback group for telemetry, service clients, action clients and its watchdog timer. Image decoding and graph work in the default group cannot hold that group lock. Controller-manager queries allow one pending request, schedule the next query one second after completion, and keep a strict two-second deadline. Transport failures back off for 1/2/4/8 seconds (capped at eight), with readiness revoked throughout the backoff. Successful responses reset the interval. A successful active/interface validation remains usable for at most 3.1 seconds while waiting for the next response, alongside the unchanged one-second live hardware/JTC/joint feedback checks. Timeout, service loss, or an explicit invalid response revokes readiness; generation tokens discard obsolete responses, including responses processed after the deadline but before the watchdog timer. Controller health and slow-response notices are transition-based; the overall health log does not repeat an identical controller failure.

The executor appends bounded, owner-scoped audit entries and ROS logger output at each motion transition, request rejection, target/trajectory/result and health change. `position_motion_info` carries cursor-based log pages; the connection-scoped desktop hook retains them even when Robot View is hidden. A separate bottom terminal displays the audit window, with an optional existing SSH reader for raw MoveIt output. The terminal's export uses a fixed native `.log` writer, validates an absolute path and a 32 MiB limit, and never executes text as commands. It is a log viewer, without shell input.

### Calibrated gripper (hardware joint7)

The ROS joint is `gripper_finger_left_joint`, a prismatic metre value; the UI labels single-finger travel in mm. STM32 feedback on `/stm32/joint_states` uses the raw actuator value despite the ROS-looking joint name. The Bridge obtains the exact hardware calibration from the real MoveIt launch's `debug_desk.gripper_*` parameters, applies position scale+offset (velocity scale only), and checks it against fresh gripper JTC feedback. The model must define explicit gripper/combined joint groups, independent prismatic URDF limits, and enabled gripper velocity/acceleration limits. Raw gripper data never drives the desktop model directly. The desktop subscribes to calibrated `/robot_feedback/joint_states` for high-rate display and uses the Bridge snapshot as a fallback; both expire within one second. Mimic fingers follow the normalized main finger.

The real stack publishes calibrated robot feedback for TF/MoveIt. Trajectory startup requests gripper support only when fresh hardware status includes bit `0x40`; arm-only operation stays available. Gripper targets additionally require the dedicated active controller with position+velocity claims, calibrated fresh feedback and matching hardware state. Existing six-axis points and HOME omit the gripper target and retain its current hold. Store version 2 migrates version 1 points without inventing a gripper position. The Bridge shares admission, watchdog, cancellation, log and stop verification across both controllers.

### Full TCP Pose planning

RViz-style arrows/rings manipulate a desired pose independently of the URDF preview. XYZ numerical coordinates are metres internally (mm in UI), fixed-axis XYZ RPY is radians internally (degrees in UI), and the wire orientation is a normalized xyzw quaternion. The Bridge only accepts the model root frame and a stable fixed tool descending from the complete arm chain. It converts the requested tool pose into the six-axis solver tip using the full fixed offset and supplies MoveIt PositionConstraint plus rotation-vector OrientationConstraint. Optional gripper JointConstraint is sampled alongside arm IK through MoveIt's automatic IK-subgroup discovery and UnionConstraintSampler in the existing combined group.

All Pose requests use plan-only and the existing shared ExecuteTrajectory/cancel/lease state machine. Before physical dispatch, FK must match the requested TCP position and orientation; measured completion must satisfy both pose and joint tracking/stop checks. Neither a planner success code nor a local preview joint solution can substitute for the pose check. Existing joint-target APIs remain compatible.

## Navigation and Motion workspace

Topics (`dashboard` remains its persisted identifier) owns the topic list, Graph,
Inspector and read-only controller cards. Motion (`motion`) owns Robot View, saved
positions, a collapsible Controller management sidebar and a bounded shared output row
with execution-log/report tabs. Reports retain the execution snapshot outside the
editor and scroll within that row; new results do not change the selected output tab.
Hidden or folded output pauses native planner-log reads.
Status retains whole-stack lifecycle operations. Motion navigation is available before
ROS readiness for inspection; command admission retains the existing safety gates.

`appNavigationLogic.ts` restores the existing `robot-console-page`, the independent
`robot-console-motion-tab` (`robot` by default), and
`robot-console-motion-controllers` (expanded by default). Invalid preferences fall
back safely. The existing connect-to-Status preference remains separate from
`ToolbarSettings`; saving page preferences does not override that connection rule.

The position-motion hook remains connection-scoped across page changes. While busy,
a global strip reports the current task, links back to Motion and permits cancellation
of this session's command; other sessions remain read-only. Robot View rendering and
RGBD interest are page-scoped: only visible Motion/Robot View acquires RGBD while live
updates are enabled. Switching to positions or another page releases its client interest
and clears the cloud without losing the retained robot scene or stopping a remote camera.

## Motion group persistence and execution

The Motion `groups` tab stores profile-scoped motion groups in a separate local
`motion-groups.v1.json` through constrained Tauri load/save commands. Steps contain
immutable six-joint and optional calibrated-gripper snapshots plus source position
identity/version. Updating a source position never silently changes an existing group.
Native validation, serialized updates and atomic file replacement preserve the prior
file when a read, validation or write fails.

The desktop submits one complete group snapshot to `PositionMotion` in the Bridge.
The ROS motion callback group owns preparation, per-step planning/execution,
feedback verification, monotonic holds, boundary pause/resume and group cancellation.
A group keeps one owner and command ID and retains the existing global motion lock
through every transition, hold and pause. Each segment uses a new internal motion
instance so a late action callback cannot complete a newer segment. Existing health,
model, controller, heartbeat and stopping gates continue between segments.
The editor's nominal timeline sums motion and hold durations; Bridge elapsed time
also includes per-segment planning and settling after preparation, and excludes pauses.
Neither a browser timer nor navigation changes dispatch another motion segment.


## Pose / Action 工作台采集路径

动作组编辑数据按连接 Profile 保存在 Mac，并继续由 Tauri 验证和原子写入。Pose 快照、设备轨道和依赖 Action 由前端独立逻辑处理；目前单臂执行请求将依赖相机 Action 嵌入对应 Pose 步骤。多机械臂轨道用于后续编排扩展，当前不具备多设备联合执行能力。

Jetson `PositionMotion` 仍拥有整组调度与全局运动锁。Pose 停稳/停留后创建相机订阅，检查源时间与实际关节反馈；独立线程编码 PNG、写入图像和反馈元数据后原子提交目录，运动回调只轮询结果，不执行编码/磁盘 I/O。下一段需确认保存成功并保持所有现有运动门禁。结果只传输路径与 120 像素 PNG 缩略图；原图留在固定的 Jetson 用户采集目录，不经桌面 Base64 大消息，也不运行任意远端命令。取消及断线令牌使迟到的保存结果无法驱动下一段。


### Compact Motion interaction

Motion composes connection/health and global tool popovers into its local header, independently of other navigation pages. Local workspace preferences retain icon navigation, resource/view choices, Inspector pinning, output visibility and docked/floating Robot View tools. Focus mode masks those panels temporarily without unmounting editors or overwriting preferences. Active task cancellation, explicit motion execution and current fault/freshness evidence remain outside context menus.

A shared pointer/keyboard menu uses current render callbacks, clamps to the viewport, restores focus on dismissal and ignores text-editing targets. Pose/Action edits reuse existing history and immutable execution snapshots; source replacement preserves step identity/timing/dependencies. Removing a Pose removes its dependent Actions/sync points in one undo operation. Persistent deletion and unsaved navigation retain their existing confirmations. Local previews, camera presets and shortcuts never dispatch motion requests. No Bridge schema, DDS path or native controller-switch authorization changes.


## 拖动示教控制路径

拖动示教通过 Tauri 固定 SSH 操作启动 ROS 栈的 `--mode=teaching`。控制栈提供六轴重力补偿/阻尼与零输出手动夹爪，不启动夹爪 JTC，也不接受示教夹爪运动请求。桌面启动前检查 `check-manual` 能力，启动后通过只读硬件标记、控制器接口和反馈核验手动配置。Mac 不加入 DDS；Status 只显示说明及实测姿态保存。远端模式操作仍使用 `arm-mode.lock`，停止由硬件持续发送 DISABLE 并确认反馈后才清理进程。示教退出不回零，需现场支撑确认。

## Tabletop object observation

Optional PCL detection runs in each existing RGBD processing worker, using that preview's depth pixels, scaled intrinsics and capture-time TF. It does not run in ROS receive callbacks and does not create a second cloud stream. Projection samples at most 30,000 points; ROI, voxel filtering, bounded RANSAC and Euclidean clusters produce at most 20 base-frame AABBs. Session-local tracking uses bounded rectangular Hungarian assignment with position, size and IoU costs. Three consecutive detections confirm a public ID; confirmed tracks retain association history for 1.5 seconds, tentative tracks for 350 ms (at most 60 tracks). Missing observations never produce boxes. Only association references are smoothed; emitted geometry remains current. Normal stream/TF gaps retain bounded history, while subscription changes, clock invalidation/generation changes and detection exceptions reset tracking. Metadata travels inside the same RCD1 envelope and shares its source-age deadline, subscription token, desktop RAF coalescing and expiry. Rendering uses Three.js line segments and sprites with explicit geometry/texture disposal; hit volumes can select an object for a preview, without initiating motion.

CMake discovers optional PCL components; `-DEASY_DEBUG_OBJECT_DETECTION=OFF` or missing PCL retains RGBD and advertises detection unavailable. Ubuntu detection builds use `libpcl-dev` (rosdep build key `libpcl-all-dev`). Configuration is loaded from a server-controlled ROS parameter path at detection subscription time; clients cannot request arbitrary file paths. Invalid configuration rejects the subscription before replacing the current session. PCL-specific algorithm tests and synthetic RGBD/TF transport tests run on ROS hosts; portable projection/tracking and desktop validation/lifecycle tests run in `npm test`.

## Segmented visual Pick

Object selection is scoped to the desktop's current RGBD subscription token and confirmed object ID. Wireframe hit volumes stop robot-picking propagation; selection itself only requests a preview. The Bridge resolves targets from the latest successfully transmitted detection snapshot, validating capture age and clock generation, rather than accepting desktop-supplied geometry.

`visual_pick.cpp` owns a bounded, session-owned Pick coordinator. Preview/start reload a server-controlled calibration file, defaulting to execution disabled. The coordinator associates admission with a recent preview and runs a worker which invokes the existing queued `PositionMotion` API for gripper and complete TCP goals. Each new approach target requires a strictly newer observation sequence (500 ms bounded wait) and measured capture-valid TCP TF; translation/angular target increments are bounded. Existing MoveIt trajectory verification and terminal measured-stop feedback remain authoritative. A global visual-task flag also blocks interleaving direct/trajectory/group/identification commands across segment boundaries. DISABLE bypasses this flag and cancels the task. The worker distinguishes client heartbeat from its own motion-info keepalive, cancels on visual loss/change, and retains ownership until the underlying motion reports a confirmed terminal state. Normal close/lift does not infer grasp success from position control alone.

Camera extrinsics, grasp-to-TCP geometry, jaw mapping, table height and the known MoveIt collision scene require field validation before enabling execution. Detection clouds are not automatically inserted into Planning Scene. Isolated coordinator tests inject simulated motion/observation/pose adapters and verify full sequencing, bounded targets, cancellation/heartbeat/loss, no follow-up after failure, nonconvergence and ID replay protection. ROS tests exercise actual binary RGBD preview routing and uncalibrated rejection without publishing production motor commands.

## RGBD-to-RGB selected-target tracking

OpenCV core/imgproc/calib3d is a Bridge build dependency. `rgb_target.cpp` owns a mutex-protected per-session target binding, independent of ephemeral PCL IDs. Selection seeds immutable RGB/depth, intrinsics and capture-time camera TF from the exact successfully sent RGBD snapshot. Learned hue and contour geometry are checked against camera-motion-compensated plane projection; at least three agreeing depth observations confirm the binding. Near-range or missing-depth handoff preserves UUID and initial grasp yaw. Uncertain/stale identity is latched until explicit release/reselection. This is a conservative colored-tabletop tracker, not general object re-identification.

ROS receive callbacks only retain latest shared RGB/depth pointers in addition to bounded pairing queues. The existing session worker processes selected-target RGB independently of pairing, with exact-time TF retries and a 500 ms source deadline. CV never holds the receive mutex. At most the seed and current processed frames are retained for binding, plus the session's bounded RGBD queues/snapshots. RCT1 carries the selected target metadata and binary RGB at up to 10 Hz; the desktop coalesces by RAF and checks lease/UUID/epoch/freshness before display. Depth expiry clears the cloud while retaining the subscription lease and selected target panel. Release uses token and UUID to prevent a late request clearing a new selection.

RGB metric fallback uses an explicitly verified stationary horizontal top plane, near-normal viewing and fresh capture-time camera TF, with identity and geometry readiness kept separate. It does not reconstruct monocular depth. The coordinator checks UUID throughout approach, preserves locked yaw, bounds RGB target steps to 3 mm and cumulative commanded RGB approach distance to 0.15 m, and retains existing calibration, controller, collision, cancellation and stop-confirmation boundaries. Configuration defaults keep plane verification disabled. Synthetic image sequences and simulated coordinator tests run locally; ROS integration uses isolated domains and never commands production motors.

RGB selection projects all eight AABB corners for the initial enclosure and samples color only from depth points inside the selected box. Initial silhouette occupancy is distinct from learned-contour tracking: rotated footprints need not fill their AABB, but candidate containment and depth membership still gate association. Subsequent tracking retains strict contour overlap/area checks. The first uncertainty cause is latched alongside identity loss. Desktop click revisions explicitly rebind even the same object ID; serialized release/preview requests remember late server bindings without applying obsolete UI responses. Both preview and RCT1 observations establish bounded freshness leases.

The RGB worker retains one pending capture snapshot for exact-time TF retries (up to 150 ms), keyed by target UUID. A missing transform does not consume the send slot or replace the pending image with the newest callback image; retries run on the worker loop. Source and observation freshness remain bounded by 500 ms, including during retries.

Selected-target processing also retains six shared depth references independently of the RGBD pairing queue. A pending RGB capture selects the closest depth timestamp (at most 50 ms apart), allowing up to 150 ms for asynchronous depth arrival before applying the existing missing-depth rules. Preview consumption cannot remove this matching history; clock generation changes clear it.

Selected RGB tracking runs on a separate per-session worker from PCL/RGBD processing, with a 30 Hz processing ceiling and independent 10 Hz binary preview. Unsubscribe joins both workers before its ACK. A bounded fixed capture is still retried for timestamp-specific TF; after consuming it the worker selects the latest RGB, without an unbounded queue. Depth absence no longer delays established RGB handoff. Freshness lapses revoke motion eligibility at 500 ms; a two-second retained identity window permits stationary-only consecutive revalidation, never automatic motion restart. PositionMotion publishes a short-lived read-only stopped lease from its executor; the tracker cannot authorize motor commands or change calibration.

## Desktop hand-eye calibration

The hand-eye page keeps RViz's Target / Context / Calibrate organization but executes board detection and hand-eye solving on the Mac. A bounded JSON stdin/stdout C++ helper uses OpenCV; production macOS bundles contain the helper and its recursively resolved, signed dylibs. The installed application does not require a user Python environment, ROS or Homebrew at runtime. Build hosts need OpenCV, pkg-config and nlohmann-json headers (`brew install opencv nlohmann-json pkg-config`); `npm run prepare:handeye` builds/packages the helper and is included in the Tauri build hook.

Continuous raw RGB uses the existing binary WebSocket path. A user-requested sample is a separate, bounded SSH operation from Tauri, running a fixed Python script with a 12-second remote deadline and an 18-second local deadline. This script only subscribes to RGB, CameraInfo, measured JointState and TF, and encodes one PNG with Python's standard library. It avoids Jetson OpenCV/NumPy ABI dependencies. Sampling requires measured stop and capture-time TF, and never uses the old base-to-camera extrinsic to infer end-effector pose. No camera transform, joint command, action goal or controller mutation is published.

Local vision calls have a single-operation semaphore, size limits and a deadline. Detector output and the original synchronized sample are committed together; failed detection cannot append a partial record. Connection/profile/page changes invalidate pending results. Sample data stays in page memory across navigation and can be explicitly saved/imported; application restart does not silently restore large images. Calibration configuration changes are locked once samples exist. Exported results are reviewable files only, not a production configuration change.


## 原生页面承载（开发中）

桌面主 WebView 负责连接和导航。功能页按白名单 URL 懒创建独立的子 WebView，在主窗口区域和独立 macOS Window 之间 reparent。页面 JS 堆与图像、模型视图不会因拆收被复制；每个页面只有一个实例。IPC 以原生调用 WebView label 和 incarnation 鉴权，重新挂到另一 Window 不改变页面身份。页面在共享 Rust 会话中独立附着消费者，主窗口不转发其数据。

主窗口弹层与子 WebView 的原生层级通过显式覆盖状态协调。页面区域更新与迁移必须串行，防止主窗口的迟到尺寸覆盖独立窗口；布局更新不能覆盖同时到达的 ready/busy 状态。关闭主窗口保留其 WebView 与原生会话，只隐藏嵌入页；独立页和 Dock 可恢复主窗口。`layout.rs` 以最多 32 KiB 的版本化配置保存窗口偏好，临时文件写入后原子替换；不序列化连接、任务或授权。后台检查显示器工作区变化，恢复普通窗口到可见范围。完整的公共轮询、任务租约与资源/Monitor 共享缓存仍在实现，详见[开发记录](./multiwindow-implementation)。

`migration.rs` / `workspace_migration.rs` 将拆收作为可恢复的事务执行，失败恢复不重建 WebView。使用仓库内补丁版 `tauri 2.11.5` 与 `tauri-runtime-wry 2.11.4`：原生 reparent 成功前保留源窗口对 WebView 的持有及父窗口元数据，失败或目标消失时返回错误，防止目标销毁事件误删存活页面的 IPC 注册。详情及许可证见两个 vendor 目录的 `PATCHES.md`。`npm run test:rust` 同时执行运行库迁移和页面注册回归测试。真实错误注入仅允许独立标识的 Debug 测试应用消费一次性配置文件，正式应用和 Release 构建没有故障注入入口。

Position/动作组/Pick 的任务占用已进入 Rust 原生会话。实际 WebView 身份、连接代次和任务编号在提交、发送前许可、迁移和终态处理间保持关联；窗口存活只由新的 IPC 入口调用刷新。Rust 看门狗处理所属窗口失联，其他窗口不能通过 Bridge 查询代为续租。传输队列另外维护停止代次，撤销停止之前尚未发送的执行指令。Position 已接入 Bridge 进程内有界终态记录与按编号恢复；未知记录不解锁。完整的非 Position/Pick 生命周期仍未接齐，不能将此机制视作完整多窗口控制安全验收。

### 多窗口公共状态查询（开发分支）

Rust 会话以固定来源调度 Agent、USB、arm mode、Controller、Topics、时钟诊断及 Motion/Pick 只读观察，各来源只有一个在途查询。主窗口和功能窗口通过事件失效通知读取有界快照，主 WebView 不负责中转或定时驱动。手动刷新与自动查询共用串行锁；用于操作后核验的请求在已有请求完成后重新发起。窗口接收端保留源帧龄并独立过期，连接代次和递增快照版本隔离旧响应。运动日志在 Rust 保存有界历史，窗口独立读取游标；只读观察不续租运动，原生任务看门狗按所属窗口存活独立续租。rosbag 与共享编辑状态仍待迁移；完整范围见多窗口实现记录。

模型和纹理的连接级字节缓存也由 Rust 持有，按 URI/编码合并在途读取并使用 LRU 限制为 128 MiB / 512 项。每个 WebView 仍需接收当前展示所需的 IPC 字节并创建自己的 GPU 场景，但不再长期保存重复的原始字节缓存。断线取消在途资源读取；资源缓存不承载控制 ACK 或改变路径边界校验。

## Docker runtime

Humble 容器使用 host 网络及独立 PID 命名空间，构建目录与 host 分离。部署与权限边界见 [Docker 运行说明](docker.md)。
