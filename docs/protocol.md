# Bridge protocol v0.1

WebSocket protocol between the **Rebotarm Debug Desk** desktop (repo [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)) and the Jetson `easy_debug_bridge`.

Messages are UTF-8 JSON WebSocket text frames.

## Requests

```json
{"op":"hello"}
```

Hello response (sent immediately after the request):

```json
{"op":"hello","bridge_version":"0.1.0","bridge_build_id":"dc8f3b4c126c","ros_distro":"humble"}
```

`bridge_version` comes from `bridge/easy_debug_bridge/package.xml`. `bridge_build_id` is a short content hash of the Bridge package sources (generated into `bridge_build_id.hpp` / `src/bridgeVersion.ts` by `npm run generate:bridge-build-id`). Older Bridges may omit `bridge_build_id`.

```json
{"op":"topics","request_id":"uuid"}
```

```json
{"op":"graph","request_id":"uuid"}
```

```json
{"op":"topic_info","request_id":"uuid","topic":"/stm32/joint_commands"}
```

```json
{"op":"node_info","request_id":"uuid","node":"/microros_stm32h723_hardware"}
```

详情请求按需读取当前 ROS Graph；名称必须是合法的绝对 ROS 名称，已离线的 Topic / Node 返回带 `request_id` 的 error。

```json
{"op":"subscribe","request_id":"uuid","topic":"/joint_states","type":"sensor_msgs/msg/JointState"}
```

`type` 必须与已发现的 Topic 类型一致。Bridge 对已知基础类型保留现有数据格式；其他已安装 ROS 2 类型支持的消息由运行时字段描述递归解码为 JSON 对象。例如 `control_msgs/msg/JointTrajectoryControllerState` 的 `actual.positions`、`time_from_start` 等嵌套内容可直接读取。缺少类型支持时返回带 `request_id` 的 error。64 位整数超出 JavaScript 安全整数范围时使用十进制字符串；NaN/Infinity 使用 `null`。

```json
{"op":"resource","request_id":"uuid","uri":"package://robot_description/meshes/base.stl"}
```

图像订阅使用每连接兴趣集合：重复 `subscribe` 不增加引用计数；只向明确订阅该 Image Topic 的连接发送像素。取消订阅或断开不会影响其他连接，最后一个兴趣消失后释放对应 ROS 订阅。其他消息类型继续沿用共享订阅/广播。

```json
{"op":"unsubscribe","request_id":"uuid","topic":"/camera/color/image_raw"}
```

`unsubscribe` 当前仅支持 Image；已订阅的非 Image Topic 返回 error。不存在的 Image 订阅可幂等取消。成功响应为 `{"op":"unsubscribed","request_id":"uuid","topic":"/camera/color/image_raw"}`，其后不会继续向该连接写入该 Topic 图像（ACK 前已排队的帧仍可能先到达）。名称必须是合法绝对 ROS 名称。

资源请求可增加 `"encoding":"binary"`。省略或 `"base64"` 返回原有 JSON，其他编码返回 error。新桌面优先请求二进制，并可解码忽略该参数的旧 Bridge Base64 响应。

MIT joint command:

```json
{
  "op":"joint_command",
  "request_id":"uuid",
  "mode":1,
  "position":[0.1,0.0,0.2,0.0,0.0,0.0],
  "velocity":0.0,
  "kp":8.0,
  "kd":2.0,
  "effort":0.0,
  "active_joint_mask":5,
  "confirmation":"ARMED"
}
```

`position` 可为标量（兼容旧客户端，仅驱动 joint1）或与 `JointCommand` 数组下标对齐的每关节数组。`active_joint_mask` 为客户端请求控制的关节位掩码（bit0=joint1）；省略时默认 `0x01`（仅 joint1）。Bridge 要求所选位全部落在固件 `HardwareStatus.active_joint_mask` 内，只对有效位写入非零通道，其余通道保持 0。v1 中 `velocity` / `kp` / `kd` / `effort` 仍为全局标量，复制到每个使能关节。

HOLD、TRACK和RETURN必须携带 `confirmation: "ARMED"`。DISABLE忽略输入值并将所有通道写零；显式 `active_joint_mask: 0` 在非 DISABLE 下会被拒绝。

JointTrajectory command (published to the `JointTrajectoryController`'s `~/joint_trajectory` subscription):

```json
{
  "op":"trajectory_command",
  "request_id":"uuid",
  "topic":"/arm/trajectory_controller/joint_trajectory",
  "joint_names":["joint1","joint2"],
  "trajectory_points":[
    {"positions":[0.1,0.2],"velocities":[],"time_from_start":0.1},
    {"positions":[0.5,-0.2],"velocities":[],"time_from_start":1.2}
  ]
}
```

`topic` 必须以 `/joint_trajectory` 结尾且只含字母数字下划线斜杠，否则拒绝。`trajectory_points` 最多 64 个点，`joint_names` 最多 32 个且不允许重复或空白；每个点的 `positions` 长度必须等于 `joint_names`，`velocities` 可为空数组，`time_from_start` 必须为正且严格递增。所有数值必须有限。Topic 上没有订阅者时返回 error。

桌面端通过现有通用 `subscribe` 读取 active 控制器的 `control_msgs/msg/JointTrajectoryControllerState`（`~/controller_state`，旧版兼容 `~/state`），按其中的 `joint_names` 构造完整关节集合和顺序，不能直接复制可能含夹爪等额外关节的 JointState。下发前要求 JointState 与控制器反馈均在 1 秒内。`trajectory_command_ack` 仅确认 Bridge 已发布消息，不是 FollowJointTrajectory action 的接受/执行结果。


### GravityIdentification（`/StartGravityID`）

对齐 [rebotarm-ros2-stack#23](https://github.com/phamstered/rebotarm-ros2-stack/pull/23) IDL 与 [#24](https://github.com/phamstered/rebotarm-ros2-stack/pull/24) FULL_ARM 编排。 Jetson bring-up：`stm32h723_arm.launch.py state_only:=true` + `gravity_identification.launch.py`。Bridge 使用 `rclcpp_action` 客户端；若 Jetson 未安装 action 头，运行时返回错误（需 stack #23 的 `microros_stm32h723_bridge` action）。

Send goal（**必须** `confirmation: "ARMED"`）：

```json
{
  "op": "gravity_id_send_goal",
  "request_id": "uuid",
  "confirmation": "ARMED",
  "joint_mask": 63,
  "mode": 0,
  "pose_set_id": [],
  "settle_time_s": 1.5,
  "capture_window_s": 1.0,
  "write_yaml": true,
  "hot_reload": true,
  "output_yaml_path": "",
  "max_effort_nm": 10.0,
  "max_velocity_rad_s": 0.15,
  "command_timeout_ms": 100,
  "lock_gripper": true
}
```

- `mode`：仅 `0`（FULL_ARM）。`1`（PAYLOAD）由 Bridge 拒绝（与 [stack#24](https://github.com/phamstered/rebotarm-ros2-stack/pull/24) 一致）；请用 Joint4 标定。
- `joint_mask` 默认 / 全 0 时按 `0x3F`。
- `command_timeout_ms`：**仅 host/编排对齐**；MCU 仍为编译期约 100 ms HOLD / 500 ms fault 11，本字段不改固件超时。

Cancel：

```json
{"op":"gravity_id_cancel","request_id":"uuid"}
```

可选状态查询：

```json
{"op":"gravity_id_status","request_id":"uuid"}
```

## Responses and events

Topic discovery:

```json
{
  "op":"topics",
  "request_id":"uuid",
  "topics":[{"name":"/joint_states","types":["sensor_msgs/msg/JointState"]}]
}
```

Topic data:

```json
{
  "op":"topic_message",
  "topic":"/joint_states",
  "data":{"name":["joint1"],"position":[0.2],"velocity":[],"effort":[]}
}
```

ROS node/topic graph:

```json
{
  "op":"graph",
  "request_id":"uuid",
  "nodes":[
    {"id":"node:/joint_state_publisher","label":"/joint_state_publisher","kind":"node","types":[]},
    {"id":"topic:/joint_states","label":"/joint_states","kind":"topic","types":["sensor_msgs/msg/JointState"]}
  ],
  "edges":[
    {"source":"node:/joint_state_publisher","target":"topic:/joint_states","relation":"publish"}
  ]
}
```

`relation` 为 `publish` 时方向是 ROS Node → Topic，为 `subscribe` 时方向是 Topic → ROS Node。Topic 节点可继续通过 `subscribe` 请求获取实时数据。

Topic 详情（与 `ros2 topic info -v` 同类信息）：

```json
{
  "op":"topic_info","request_id":"uuid",
  "topic_info":{
    "name":"/stm32/joint_commands",
    "types":["microros_stm32h723_bridge/msg/JointCommand"],
    "publishers":[{"node_name":"microros_stm32h723_hardware","node_namespace":"/","topic_type":"microros_stm32h723_bridge/msg/JointCommand","endpoint_type":"PUBLISHER","gid":"01.0f.3d.7c","qos":{"reliability":"BEST_EFFORT","history":"UNKNOWN","depth":0,"durability":"VOLATILE","lifespan":"Infinite","deadline":"Infinite","liveliness":"AUTOMATIC","liveliness_lease_duration":"Infinite"}}],
    "subscriptions":[]
  }
}
```

`gid` 实际包含完整的 RMW GID 字节；示例为缩写。QoS 时长为 `Infinite`、`Default` 或 `<sec>s <nsec>ns`。端点数量以数组长度为准，响应反映请求时的发现快照。

Node 详情：

```json
{"op":"node_info","request_id":"uuid","node_info":{"name":"/microros_stm32h723_hardware","namespace":"/","publishers":[{"name":"/stm32/joint_commands","types":["microros_stm32h723_bridge/msg/JointCommand"]}],"subscriptions":[],"services":[],"clients":[]}}
```

Resource:

```json
{
  "op":"resource",
  "request_id":"uuid",
  "uri":"package://robot_description/meshes/base.stl",
  "mime":"model/stl",
  "base64":"..."
}
```

二进制资源为单条 WebSocket binary message（可能由多个 WebSocket continuation frame 组成）：

| 字节 | 内容 |
| --- | --- |
| 0–3 | ASCII `RCR1`，与图像的 `RCI1` 区分 |
| 4–7 | 大端 uint32，UTF-8 JSON 元数据长度 |
| 8… | 元数据后紧接原始文件字节 |

元数据：`{"op":"resource","request_id":"uuid","uri":"package://robot_description/meshes/base.stl","mime":"model/stl","data_length":1234}`。`data_length` 必须与实际负载长度完全相符；零字节文件合法。客户端按 `request_id` 关联请求，资源响应不参与 Topic 广播。超过 64 MiB、读取不完整和不存在的文件返回带 `request_id` 的 error。取消本地请求会清除等待并忽略迟到响应；当前不会撤销服务器已开始的读取或写入。

`uri` 仅接受 `package://<package>/<relative-path>`。Bridge 会在跟随资源符号链接前校验相对路径边界，因此兼容 ROS 2 `--symlink-install`，同时拒绝绝对路径、package 根目录和越过 package 目录的 `..` 路径。

Error:

```json
{"op":"error","request_id":"uuid","message":"错误说明"}
```

Command acknowledgement:

```json
{"op":"joint_command_ack","request_id":"uuid","sequence":42,"mode":1}
```

Trajectory command acknowledgement:

```json
{"op":"trajectory_command_ack","request_id":"uuid","joints":2,"points":2}
```

Gravity ID feedback（Bridge → Desk，节流 ≤10 Hz）：

```json
{
  "op": "gravity_id_feedback",
  "phase": 5,
  "pose_index": 3,
  "pose_count": 12,
  "active_joint_mask": 63,
  "residual_nm": [0.1, 0.2, 0.05, 0.3, 0.0, 0.0],
  "measured_effort_nm": [],
  "model_effort_nm": [],
  "rmse_running": 0.12,
  "fault_code": 0,
  "message": "capturing pose 3"
}
```

Gravity ID result：

```json
{
  "op": "gravity_id_result",
  "success": true,
  "fault_code": 0,
  "gravity_scales": [1,1,1,1,1,1],
  "torque_biases_nm": [0,0,0,0,0,0],
  "rmse_per_joint": [0.01,0.01,0.01,0.01,0.01,0.01],
  "rmse_total": 0.02,
  "yaml_path": "/path/to/gravity.yaml",
  "message": "ok"
}
```

Gravity ID status（推送或应答）：

```json
{"op":"gravity_id_status","status":"executing"}
```

## RGBD 点云预览（RCD1）

Desk Robot View 通过独立的 `subscribe_rgbd` / `unsubscribe_rgbd` 请求彩色点云预览流。该路径**不**写入 Image 兴趣集合：取消 RGBD 不会取消 Inspector 对同一 Image Topic 的订阅，反之亦然。

### 订阅

请求：

```json
{
  "op": "subscribe_rgbd",
  "request_id": "uuid",
  "rgb_topic": "/cameras/left_arm/wrist/color/image_raw",
  "depth_topic": "/cameras/left_arm/wrist/aligned_depth_to_color/image_raw",
  "camera_info_topic": "/cameras/left_arm/wrist/color/camera_info",
  "target_frame": "base_link",
  "max_width": 320,
  "max_height": 240,
  "max_fps": 12
}
```

成功：`{"op":"subscribed_rgbd","request_id":"uuid", ...topics...}`。同一连接重复订阅会替换该连接上的 RGBD 会话。

取消：`{"op":"unsubscribe_rgbd","request_id":"uuid"}` → `{"op":"unsubscribed_rgbd","request_id":"uuid"}`。

默认 Topic 与左臂腕部 RealSense 启动入口一致：`camera_namespace=cameras/left_arm`、`camera_name=wrist`、`align_depth.enable=true`、`enable_sync=true`。已有完整旧默认 Topic 组合在加载时迁移；用户自定义组合保持原值。Bridge 不替任意 CameraInfo / 未对齐 Depth 做空间配准。
RGB、对齐 Depth 和 CameraInfo 分别按各自发布端选择可靠性；这三个连续数据订阅均使用 `VOLATILE`。RealSense 图像可提供 `TRANSIENT_LOCAL`，而 CameraInfo 可仅提供 `VOLATILE`，因此不能复用图像的 durability。

### 二进制帧 `RCD1`

| 偏移 | 内容 |
| --- | --- |
| 0–3 | ASCII `RCD1` |
| 4–7 | 元数据 UTF-8 字节长度（大端 uint32） |
| 8… | JSON 元数据 |
| 随后 | RGB 像素紧接 Depth 像素（`data_offset` / `data_length` 指向负载） |

元数据 `op` 为 `rgbd_frame`，包含 `rgb` / `depth` 图像头（含 `header.stamp`、`encoding`、`step`、`data_offset`）、缩放后的 `camera_info.k`、`source_frame` / `target_frame`、`stamp_diff_ns`、以及图像采集时刻的 `pose`（`target_frame ← source_frame`）。`tf_ok:false` 时可为文本 JSON（无像素），Desk 标记点云过期并保留上一帧。

Jetson 侧按时间戳配对 RGB/Depth（默认容差 50ms）、预览降采样并缩放内参，再按 RGB 时间戳查询 TF；只保留最新完整组。深度编码支持 `16UC1`（毫米）与 `32FC1`（米）。

## MoveIt2 保存点位执行

固定组 `arm`（joint1–joint6），固定 MoveIt Action `/move_action` 和真实控制器 `arm_trajectory_controller`。其他组、任意 Action/Topic 名称不接受配置。

- `{"op":"position_motion_info","request_id":"..."}` 返回 `available`、门禁失败 `message`、当前 SRDF `home_positions`（未同步为空）、全局 `busy` 和本会话拥有的 `command_id`。连接期间每秒轮询该操作续约会话心跳（5 秒超时取消）。若本会话有运动，随后发送其最新状态。
- `{"op":"position_move","request_id":"...","command_id":"UUID","label":"取料位","confirmation":"ARMED","home":false,"positions":[0,-0.2,-0.3,0,0,0]}`。positions 固定按 joint1–joint6，目标为点击时快照。`home:true` 时在 Bridge 读取当前 SRDF HOME，忽略客户端 positions。
- `position_motion_info` 另返回 `joint_rotation_supported:true` 表示支持单关节目标。字段缺失时客户端必须禁用此功能，不能回退为普通点位请求。
- 单关节请求：`{"op":"position_move","request_id":"...","command_id":"UUID","label":"joint2 旋转","confirmation":"ARMED","joint_name":"joint2","joint_position":-0.3}`，角度单位 rad。`joint_name` 仅支持 joint1–joint6，`joint_position` 必须有限且在 MoveIt URDF 限位内。不能与 `home:true` 或任何 `positions` 字段混用；缺少配对字段时拒绝。
- 单关节受理时由 Bridge 从当前 STM32 JointState 取得其他五轴的目标值，在 MoveIt 请求 `path_constraints.joint_constraints` 中约束其围绕起点 ±0.001 rad；选中轴使用现有关节目标约束。保持原碰撞规划、速度/加速度缩放、会话和取消保护。此约束不构成物理跟踪误差为零的保证。
- 联合关节请求：`{"op":"position_move","request_id":"...","command_id":"UUID","confirmation":"ARMED","joint_targets":{"joint1":0.1,"joint2":-0.3},"motion_duration_s":5}`。`joint_targets` 必须为包含 1–6 个唯一 joint1–joint6 键的对象，值为有限 rad，不能与 `positions`、`home:true` 或旧单关节字段混用。未编辑轴由 Bridge 实测反馈补齐，并添加 ±0.001 rad 路径保持约束；全部六轴指定时不加保持约束。旧 `joint_name` / `joint_position` 仍兼容。
- `motion_duration_s` 可选，须为有限正数，精度至少 1 ns、最大 2147483647 秒（ROS 时间表示边界）；无 0.1–120 秒业务门禁。指定时 plan-only 规划的速度/加速度缩放为 1.0，原始时长通过 `position_motion.recommended_duration_s` 返回界面，仅供参考。时间可统一伸长或压缩，速度/加速度按倍率缩放；校验整段样条速度/加速度不超过当前每轴 MoveIt 上限（配置必须启用且不超过 1 rad/s、1 rad/s²），超限时 failed 并且不发送 ExecuteTrajectory。压缩时缺少导数数据不能验证则拒绝。省略时保持原 MoveGroup 直接执行。总运动 watchdog 为 max(180, 指定时长+60) 秒；心跳仍为 5 秒。
- `position_motion_info` 广告 `joint_targets_supported:true`、`motion_duration_supported:true`。客户端缺少任一能力时不能提交联合定时运动，不能静默丢弃时长或降级为旧点位请求。`motion_duration_message` 非空表示定时执行入口未就绪（例如 `/execute_trajectory` 缺失），客户端显示该原因。规划/执行两个阶段共享 command_id、互斥、心跳与取消状态；断线或取消后不启动下一阶段。
- 执行前要求 active JTC 认领六关节 `position+velocity`、实测速度 ≤0.05 rad/s、JTC actual 与 STM32 实测位置偏差 ≤0.02 rad，并校验反馈新鲜、完整、有限、硬件 TRACK/无故障及六轴使能；不满足时 `available:false` / `accepted:false` 的 `message` 说明原因。点位与单关节请求均已移除启动连续性检查，不再以 JTC desired/reference 的位置偏差、参考速度、字段存在性或连续稳定 200 ms 作为门禁。MoveIt 仍使用真实实测起点，自身起点容差、限位与碰撞检查保持有效。
- 成功受理返回 `position_move_ack` 与 `command_id`；门禁拒绝返回同一 ACK、`accepted:false` 与 `message`。Bridge 缓存最近 256 个已受理指令的 command_id，缓存内重复请求不重复执行；不同会话不能抢占运动。ACK 不代表规划成功或到达。
- 状态推送 `{"op":"position_motion","command_id":"UUID","label":"取料位","motion_phase":"executing","message":"...","code":0,"elapsed_s":1.2}`。阶段为 validating/planning/executing/verifying/canceling/stopping/stop_failed/succeeded/failed/canceled。`code` 为 MoveIt 结果错误码（成功 1）。只有 Action 成功及终点误差/停稳验证通过才报告 succeeded。
- `{"op":"position_cancel","request_id":"...","command_id":"UUID"}` 只允许拥有者取消，返回 `position_cancel_ack`；停止结果以状态推送为准。断线、反馈超时/故障及超时由 Jetson watchdog 取消；停止未确认保持全局锁，保留既有现场安全停机入口。

MoveIt 编译依赖缺失时 info 返回 unavailable，move/cancel 返回明确错误。协议不提供任意 ROS action 执行入口。
