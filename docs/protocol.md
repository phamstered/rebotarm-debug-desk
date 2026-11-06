# Bridge protocol v0.1

WebSocket protocol between the **Rebotarm Debug Desk** desktop (repo [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)) and the Jetson `easy_debug_bridge`.

Messages are UTF-8 JSON WebSocket text frames.

## Requests

```json
{"op":"hello"}
```

Hello response (sent immediately after the request):

```json
{"op":"hello","bridge_version":"0.1.0","bridge_build_id":"dc8f3b4c126c","ros_distro":"humble","controllers_info_supported":true}
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


### Controller 列表与查询状态

`hello.controllers_info_supported` 表示是否编译了 Controller Manager 消息支持，独立于 MoveIt 功能。缺少或为 false 时，新桌面明确提示升级/补全 Bridge，不回退到每次启动 ROS CLI 的查询路径。

```json
{"op":"controllers_info","request_id":"uuid","refresh":false}
```

省略 `refresh` 或为 false 时立即读取共享缓存，不额外发起 ROS 请求。Bridge 的常驻 `/controller_manager/list_controllers` 客户端同时为列表与运动健康检查提供数据：最多一个在途请求，响应上限 2 秒，成功后间隔 1 秒轮询，失败后按 1/2/4/8 秒退避，迟到响应不能覆盖新状态。列表查询不改变 Controller/硬件状态，也不续期运动任务的拥有者租约。

```json
{"op":"controllers_info","request_id":"uuid","supported":true,"manager":"/controller_manager","available":true,"fresh":true,"has_snapshot":true,"snapshot_sequence":12,"snapshot_age_ms":84,"snapshot_time_ms":1793623704000,"query_state":"ready","query_pending":false,"retry_after_ms":0,"request_wait_ms":0,"controllers":[{"name":"arm_trajectory_controller","type_name":"joint_trajectory_controller/JointTrajectoryController","state":"active"}],"message":""}
```

- `controllers` 保留服务最近一次成功返回的完整列表；`snapshot_sequence` 只随成功快照递增。成功的空列表也有有效快照；从未成功时 `has_snapshot:false`、序号 0、列表为空，省略两个时间字段。
- `snapshot_time_ms` 是 Jetson 保存快照时的 Unix 毫秒；`snapshot_age_ms` 由单调时钟计算。`available` 与 `fresh` 相等，仅在最近查询未失败且快照年龄 <3100 ms 时为 true；在途查询可在此期限内保留有效的前次快照。
- 查询超时、服务不可用或其他失败立即失效，但保留最后成功的行供只读查看；旧行不能作为当前控制状态或执行许可。`request_wait_ms` 是本请求进入 Registry 到生成同一份快照响应之间的单调等待时长，范围 0–5000 ms；缓存/立即响应可为 0，之后的发送队列等待不计入它。前端把 `max(0, 请求往返耗时 − request_wait_ms)` 保守加到快照年龄，再按本机单调时钟累计，覆盖传输、发送排队及界面调度延迟；超期自动失效，断线/重连清除旧会话数据。
- `query_state` 为 `waiting`（初始等待）、`ready`、`pending`、`timeout`、`unavailable`（ROS 服务不可用）、`error`、`stale` 或 `unsupported`；`query_pending` 表示是否有在途请求，`retry_after_ms` 给出下一次允许查询前的剩余退避时间。WebSocket 断开或请求失败由桌面单独标记，不能据此认定 Controller 已停用。
- `refresh:true` 为强制核验：只能由本请求进入之后才发起的 ROS 查询完成，不能用旧缓存或预先在途的响应证明刷新成功。多个等待者合并后续请求；既有请求先结束或超时，再进行新查询，显式强制查询可跳过成功后的轮询间隔，失败退避仍有效。每个等待者最长 5 秒，全局最多 64 个、每连接最多 8 个；断开清理该连接等待者。
- 桌面每秒读取缓存；手动刷新和 Controller 切换前后使用强制核验。切换后先排空操作期间发起的界面查询，再请求新的核验，避免用切换前的状态确认结果。Controller 类型、active/interface、硬件、时钟、反馈及运动门禁继续独立校验。

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

订阅可带可选 `subscription_id`（非空字符串，最长 128 字符），新 Bridge 在 ACK、每个二进制成功帧及文本失败帧回显。`hello.rgbd_subscription_id_supported:true` 表示支持该隔离能力。桌面每次订阅生成新令牌；已发现能力时拒绝缺少令牌或令牌不匹配的帧，隐藏视图、重连及改配置会取消旧帧处理。旧 Bridge 无该能力时仍按兴趣与 Topic/目标坐标系过滤；相同配置的旧网络帧无法获得强代次保证，升级后重连可启用。

成功：`{"op":"subscribed_rgbd","request_id":"uuid", ...topics...}`。同一连接重复订阅会替换该连接上的 RGBD 会话。使用相同 RGB/Depth/CameraInfo Topic 组合的连接共享底层 ROS 订阅，每个连接仍独立配对、查询 TF、降采样和发送；尺寸、帧率、目标坐标系、令牌和取消语义不共享。

取消：`{"op":"unsubscribe_rgbd","request_id":"uuid"}` → `{"op":"unsubscribed_rgbd","request_id":"uuid"}`。

默认 Topic 与左臂腕部 RealSense 启动入口一致：`camera_namespace=cameras/left_arm`、`camera_name=wrist`、`align_depth.enable=true`、`enable_sync=true`。已有完整旧默认 Topic 组合在加载时迁移；用户自定义组合保持原值。Bridge 不替任意 CameraInfo / 未对齐 Depth 做空间配准。
RGB、对齐 Depth 和 CameraInfo 的实时预览订阅均使用 `BEST_EFFORT + VOLATILE + KeepLast(3)`，兼容可靠及尽力发布端，并避免预览积压历史帧。RealSense 图像可提供 `TRANSIENT_LOCAL`，而 CameraInfo 可仅提供 `VOLATILE`，因此不能复用图像的 durability。

### 二进制帧 `RCD1`

| 偏移 | 内容 |
| --- | --- |
| 0–3 | ASCII `RCD1` |
| 4–7 | 元数据 UTF-8 字节长度（大端 uint32） |
| 8… | JSON 元数据 |
| 随后 | RGB 像素紧接 Depth 像素（`data_offset` / `data_length` 指向负载） |

元数据 `op` 为 `rgbd_frame`，包含 `rgb` / `depth` 图像头（含 `header.stamp`、`encoding`、`step`、`data_offset`）、缩放后的 `camera_info.k`、`source_frame` / `target_frame`、`stamp_diff_ns`、以及图像采集时刻的 `pose`（`target_frame ← source_frame`）。`tf_ok:false` 时可为文本 JSON（无像素），Desk 立即隐藏旧点云并保留错误原因。完整 RGB/Depth/内参/采集时刻 Pose 按动画帧整体取最新组；错误会取消尚未绘制的旧成功组，后续有效完整组可恢复显示。最近有效完整帧到达后使用单调时间隐藏过期点云，最长有效期为 500 ms。成功帧可含 `frame_age_ms`（Jetson 打包时 RGB/Depth 中较老源图像的帧龄）；桌面按 `500 - frame_age_ms` 缩短接收后的显示期限，负值/非有限值及 ≥500 ms 拒绝显示。旧 Bridge 缺少帧龄时保留接收后 500 ms 上限，不能由重新绘制或坏帧延长有效期。这是源处理帧龄与本地接收 TTL 的组合，不包含无法测量的 SSH 网络传输时间，不能宣称端到端硬 500 ms。

Jetson 侧从各最多三帧的队列按时间戳配对 RGB/Depth（默认容差 50ms），优先差值最小且较新的组合，每组只消费一次。接收线程仅更新队列；每会话工作线程以零等待查询采集时刻 TF，最多重试 150ms，成功后预览降采样、缩放内参并发送。源帧达到 500ms 即丢弃，持续缺少有效帧超过 500ms 才报告不可用；真实时钟异常立即报告。RGBD 写入期限取源帧剩余有效期与 250ms 较小值，阻塞超时关闭该客户端连接。深度编码支持 `16UC1`（毫米）与 `32FC1`（米）。

## MoveIt2 保存点位执行

固定组为 `arm`（joint1–joint6）、`gripper`（独立夹爪）或 `arm_with_gripper`（联合七自由度）。固定 MoveIt Action `/move_action`，执行仅允许真实 `arm_trajectory_controller` 和可选 `gripper_trajectory_controller`；客户端不能指定组名或任意 Action/Topic。

- `{"op":"position_motion_info","request_id":"..."}` 返回 `available`、门禁失败 `message`、当前 SRDF `home_positions`（未同步为空）、全局 `busy` 和本会话拥有的 `command_id`。连接期间每秒轮询该操作续约会话心跳（5 秒超时取消）。若本会话有运动，随后发送其最新状态。
- `{"op":"position_move","request_id":"...","command_id":"UUID","label":"取料位","confirmation":"ARMED","home":false,"positions":[0,-0.2,-0.3,0,0,0]}`。positions 固定按 joint1–joint6，目标为点击时快照。`home:true` 时在 Bridge 读取当前 SRDF HOME，忽略客户端 positions。
- `position_motion_info` 另返回 `joint_rotation_supported:true` 表示支持单关节目标。字段缺失时客户端必须禁用此功能，不能回退为普通点位请求。
- 单关节请求：`{"op":"position_move","request_id":"...","command_id":"UUID","label":"joint2 旋转","confirmation":"ARMED","joint_name":"joint2","joint_position":-0.3}`，角度单位 rad。`joint_name` 支持 joint1–joint6（rad）及具备夹爪能力时的 `gripper_finger_left_joint`（m），`joint_position` 必须有限且在有效模型/标定限位内。不能与 `home:true` 或任何 `positions` 字段混用；缺少配对字段时拒绝。
- 单关节受理时由 Bridge 从当前 STM32 JointState 取得其他五轴的目标值，在 MoveIt 请求 `path_constraints.joint_constraints` 中约束其围绕起点 ±0.001 rad；选中轴使用现有关节目标约束。保持原碰撞规划、速度/加速度缩放、会话和取消保护。此约束不构成物理跟踪误差为零的保证。
- 联合关节请求：`{"op":"position_move","request_id":"...","command_id":"UUID","confirmation":"ARMED","joint_targets":{"joint1":0.1,"joint2":-0.3},"motion_duration_s":5}`。`joint_targets` 必须为包含 1–7 个唯一受控关节键的对象，六轴值为有限 rad，可选 `gripper_finger_left_joint` 值为有限 m，不能与 `positions`、`home:true` 或旧单关节字段混用。未编辑轴由 Bridge 实测反馈补齐，并添加 ±0.001 rad 路径保持约束；全部六轴指定时不加保持约束。旧 `joint_name` / `joint_position` 仍兼容。
- `motion_duration_s` 可选，须为有限正数，精度至少 1 ns、最大 2147483647 秒（ROS 时间表示边界）；无 0.1–120 秒业务门禁。指定时 plan-only 规划的速度/加速度缩放为 1.0，原始时长通过 `position_motion.recommended_duration_s` 返回界面，仅供参考。时间可统一伸长或压缩，速度/加速度按倍率缩放；校验整段样条速度/加速度不超过当前每轴 MoveIt 上限（配置必须启用且不超过 2 rad/s、2 rad/s²），超限时 failed 并且不发送 ExecuteTrajectory。压缩时缺少导数数据不能验证则拒绝。省略且仅涉及六轴时保持原 MoveGroup 直接执行。含夹爪的请求始终先 plan-only，省略时长则采用规划推荐时长，再校验并通过 ExecuteTrajectory 执行。总运动 watchdog 为 max(180, 指定时长+60) 秒；心跳仍为 5 秒。
- 自动执行时长：未指定 `motion_duration_s` 的 plan-only 路径允许 Bridge 在连续样条动态限幅验证失败时有界延长时长并重新校验；显式指定时长不自动调整。`recommended_duration_s` 仍为 MoveIt 原始推荐时长，最终执行时长及调整原因通过既有 Motion 日志 `plan_retime` / `plan_timing` 返回，不新增协议字段。
- `position_motion_info` 广告 `joint_targets_supported:true`、`motion_duration_supported:true`。客户端缺少任一能力时不能提交联合定时运动，不能静默丢弃时长或降级为旧点位请求。`motion_duration_message` 非空表示定时执行入口未就绪（例如 `/execute_trajectory` 缺失），客户端显示该原因。规划/执行两个阶段共享 command_id、互斥、心跳与取消状态；断线或取消后不启动下一阶段。
- 执行前要求 active JTC 认领六关节 `position+velocity`、实测速度 ≤0.05 rad/s、JTC actual 与 JointState Broadcaster `/joint_states` 中对应六轴位置偏差 ≤0.02 rad，并校验反馈新鲜、完整、有限、硬件 TRACK/无故障及六轴使能；不满足时 `available:false` / `accepted:false` 的 `message` 说明原因。点位与单关节请求均已移除启动连续性检查，不再以 JTC desired/reference 的位置偏差、参考速度、字段存在性或连续稳定 200 ms 作为门禁。MoveIt 仍使用真实实测起点，自身起点容差、限位与碰撞检查保持有效。
- 成功受理返回 `position_move_ack` 与 `command_id`；门禁拒绝返回同一 ACK、`accepted:false` 与 `message`。Bridge 缓存最近 256 个已受理指令的 command_id，缓存内重复请求不重复执行；不同会话不能抢占运动。ACK 不代表规划成功或到达。
- 一致性检查固定订阅 `/joint_states`（JointState Broadcaster），按关节名比较最新位置；Broadcaster 缺失/接收超过 1 秒、源时间戳无效、落后 Jetson 达 1 秒或超前超过 50 ms 时拒绝，不回退到 STM32 原始输入。重复源时间戳不刷新接收有效期。夹爪 JTC actual 与 Broadcaster 的米制位置按 ≤0.001 m 校验，Broadcaster 值不重复应用夹爪标定；原始反馈标定后的行程与停稳检查保留。差值异常消息指出源 Topic、关节和有符号差值（JTC−Broadcaster）。两路同属 ros2_control 状态输出，但该检查仍使用各自最新帧，不保证同一控制周期或时间戳完全相等。
- 配置的 STM32 JointState 仍用于固件时钟健康、模型限位、规划实测起点、停止/到位反馈和夹爪原始量标定。硬件 TRACK、故障、使能、控制器 active、会话及取消门禁保持；更换一致性比较源不会取消这些独立检查。
- 状态推送 `{"op":"position_motion","command_id":"UUID","label":"取料位","motion_phase":"executing","message":"...","code":0,"elapsed_s":1.2}`。阶段为 validating/planning/executing/verifying/canceling/stopping/stop_failed/succeeded/failed/canceled。`code` 为 MoveIt 结果错误码（成功 1）。只有 Action 成功及终点误差/停稳验证通过才报告 succeeded。
- `{"op":"position_cancel","request_id":"...","command_id":"UUID"}` 只允许拥有者取消，返回 `position_cancel_ack`；停止结果以状态推送为准。断线、反馈超时/故障及超时由 Jetson watchdog 取消；停止未确认保持全局锁，保留既有现场安全停机入口。

MoveIt 编译依赖缺失时 info 返回 unavailable，move/cancel 返回明确错误。协议不提供任意 ROS action 执行入口。

### 规划执行日志增量同步

`position_motion_info` 可附带 `motion_log_session: string`、`motion_log_after: uint64`。响应新增：

- `motion_log_session`：Bridge 进程日志序列标识；不匹配或未提供时从当前保留窗口开始。
- `motion_logs`：按 `seq` 递增的最多 256 条记录，每条含 `seq`、`timestamp_ms`（UTC Unix 毫秒）、`command_id`、`phase`、`level`（`info|warn|error`）、`message`。非健康记录仅对运动所属 WebSocket 会话可见；公共健康诊断不含其他会话目标。
- `motion_log_cursor`：下一次请求的 `motion_log_after`，跳过不属于本会话的记录；独立于运动心跳/受理/完成语义。
- `motion_log_truncated`：非零游标落在已淘汰记录之前，表示存在同步缺口。Bridge 保留全局最近 2048 条，每条消息最多 8192 字节；完整过程同时写入 ROS logger。

客户端未提供上述字段时仍可读取信息；旧 Bridge 不返回日志字段，点位协议保持兼容。日志查询只读，不创建运动、不执行轨迹。`position_motion` 保持原有状态事件格式，定期重发的状态快照不重复生成审计条目。

### joint7 夹爪扩展

`position_motion_info` 返回：

| 字段 | 语义 |
| --- | --- |
| `gripper_supported` | 新鲜模型、标定、规划组、限幅及控制器映射通过核验 |
| `gripper_available` / `gripper_message` | 当前能否执行夹爪目标及具体阻止原因 |
| `gripper_joint_name` | 固定 `gripper_finger_left_joint`，不是可任意配置的执行名 |
| `gripper_lower` / `gripper_upper` | 有效单指行程范围，单位 m，取已核验的硬件标定范围 |
| `gripper_feedback_fresh` / `gripper_position` / `gripper_feedback_age_ms` | 标定模型有效且原始反馈在 1 秒内、位于有效行程时提供的米制位置；过期不返回位置；客户端按年龄在剩余 1 秒有效期内本地过期，查询卡住时不能继续采集旧值 |

旧 Bridge 缺少上述能力时，客户端不得发送夹爪目标或把失败请求降级为六轴运动。未就绪时仍允许六轴管理和原有运动。反馈快照不要求硬件已 TRACK，因此可在无运动时采集位置；执行还需全部安全门通过。

保存点位使用六轴 `positions` 加可选 `gripper_position`（有限 m）；完整 TCP Pose 也可带该夹爪目标。该字段不能与 HOME、`joint_targets` 或单关节字段混用；省略表示不改变夹爪，绝不补 0。HOME 始终只使用 SRDF arm/home。关节调整/TCP 确认使用 `joint_targets`，例如：

```json
{"op":"position_move","request_id":"uuid","command_id":"uuid","confirmation":"ARMED","joint_targets":{"joint2":-0.3,"gripper_finger_left_joint":0.025},"motion_duration_s":5}
```

仅夹爪目标选择 `gripper` 组，六轴加夹爪选择 `arm_with_gripper`，其余选择 `arm`。夹爪不参与 TCP 位置 IK。Bridge 不接受 `joint7` 别名或 mimic 手指为独立目标。

夹爪目标额外要求新鲜 TRACK/无故障/bit0x40、专用 JTC active 且认领 position+velocity、控制器米制实测与标定原始反馈差 ≤1 mm，以及启动时速度 ≤1 mm/s。MoveIt 参数须提供与硬件相同的 scale/offset 和有效范围（首版最大 0–0.05 m），启用 ≤0.02 m/s、≤0.04 m/s² 限幅。目标容差 0.5 mm；执行前起点差 ≤1 mm。Action 成功后夹爪速度 ≤1 mm/s，连同机械臂停稳持续 200 ms 才报告执行完成，最终位置误差改为诊断；取消也等待新鲜停止反馈。执行完成不表示夹持成功。

## TCP XYZ/RPY 完整位姿扩展

`position_motion_info.tcp_pose_supported:true` 表示支持完整 TCP Pose 规划。能力缺失时客户端禁用 Pose 确认，不降级为位置 IK 或关节目标；其余关节/点位 API 保持兼容。

```json
{
  "op":"position_move", "request_id":"uuid", "command_id":"uuid",
  "confirmation":"ARMED", "label":"TCP 位姿",
  "tcp_pose":{
    "frame_id":"base_link", "tcp_link":"gripper_link",
    "position":[0.2,0.0,0.3], "orientation":[0.0,0.0,0.0,1.0]
  },
  "motion_duration_s":5, "gripper_position":0.025
}
```

- `position` 为精确三个有限米值；`orientation` 为四个有限 xyzw 值，四元数范数与 1 差不超过 1e-3，再在服务端归一化。零四元数、重复/未知字段、错误数组长度拒绝。
- `frame_id` 必须是当前 URDF 根 link；`tcp_link` 必须在完整 joint1–joint6 链之后、仅通过 fixed joint 连接，或为 joint6 子 link。可动手指、mimic link 目标、未知/循环/断开的模型均拒绝；不提供任意 TF/命令入口。
- `tcp_pose` 不能与任何 `home`（包括 false）、`positions`、`joint_targets`、`joint_name`、`joint_position` 字段混用。可附带现有 `gripper_position`（m）与 `motion_duration_s`；省略夹爪保持当前，省略时长先采用 MoveIt 推荐时长，样条动态超限时按自动执行时长规则延长并复验。
- Bridge 将 TCP fixed 偏移转换为机械臂求解器 tip 的位置与姿态约束，位置球半径 3 mm、旋转向量分量容差 0.005 rad。夹爪存在时附带独立 JointConstraint；其模型、标定、接口与硬件门禁不变。
- Pose 始终 plan-only；执行前核对关节集合、限位、全段时序/速度/加速度、实测起点及 FK 终点（TCP 位置 ≤5 mm、姿态最短角 ≤0.02 rad）。姿态被规划器忽略时，即使 Action success 也拒绝 ExecuteTrajectory。
- Action 结果、取消和心跳沿用点位协议。实测 TCP 位姿仍须达标、所有受控轴停稳持续 200 ms 才成功；计划关节最终位置误差不再作为额外完成门槛；姿态不达标报告失败。MoveIt 的关节空间路径不保证笛卡尔直线或逐点跟随鼠标。

## 时钟同步健康

桌面连接后每秒请求 `{"op":"clock_sync_info","request_id":"uuid"}`，同一时间最多一个请求。响应使用 Jetson 的 ROS 时间和单调接收帧龄，Mac 不计算两台主机的时钟偏差：

```json
{"op":"clock_sync_info","request_id":"uuid","supported":true,"state":"unsynchronized","message":"关节反馈时间超前，等待重新同步","source_topic":"/stm32/joint_states","source_offset_ms":15400,"feedback_age_ms":4,"generation":1}
```

- `state`：`waiting` 等待反馈，`synchronized` 时间已对齐，`unsynchronized` 时间异常，`stale` 反馈过期。`source_offset_ms` 是源 stamp 减去 Jetson 接收时 ROS 时间，正值表示超前；`feedback_age_ms` 使用单调接收时间。`generation` 标识时间基准代次，源时间大幅回拨或主机时钟跳变后更新。
- 可选 `firmware` 包含 `supported`，以及可选 `synchronized`、`sync_age_ms`、`failure_count`、`last_sync_duration_ms`。旧固件缺少这些诊断时不得声称已验证固件同步状态。
- Bridge 校验源时间不超前 50 ms、落后不足 1 秒；首次有效、长时间断流及大回拨后需连续 200 ms 有效反馈。v2 固件诊断读取 `/stm32/microros_diagnostics` 的 24 项 schema：索引 16 为同步状态、17 为距成功同步毫秒数、19 为失败数、20 为最近耗时、22 为固件时间代次；同步有效期 15 秒、诊断接收有效期 3 秒。未知或无效新 schema 不降级为同步成功。
- 桌面请求期限 2 秒，成功状态超过 2.5 秒未刷新转为过期；断线和连接配置变化立即清除上一会话。未知操作或 `supported:false` 显示不支持并停止本会话重试。无效/非有限偏差、帧龄及不完整的成功状态不视为同步成功。

## Motion 动作组（逐点到位）

`position_motion_info` 的 `motion_group_supported:true` 表示支持 Bridge 执行动作组；字段缺失或 false 时桌面端禁用组执行，不能降级为浏览器定时发送单点。

开始请求：

```json
{"op":"position_group_start","request_id":"...","command_id":"UUID","label":"动作组 · 取放","confirmation":"ARMED","group_id":"group-1","preparation_duration_s":2,"steps":[{"id":"a","label":"A","positions":[0,-0.2,-0.3,0,0,0],"motion_duration_s":0,"hold_duration_s":0},{"id":"b","label":"B","positions":[0,-0.1,-0.2,0,0,0],"motion_duration_s":5,"hold_duration_s":2}]}
```

每帧是已保存位置的六轴快照，可选 `gripper_position` 为米制夹爪目标。整组只要包含夹爪目标，各段都使用七轴校验；缺失该字段的段在前段执行成功并停稳后捕获新鲜实测开度，并在该段运动、停留及暂停期间保持它，不重新修正上一段的名义目标。第一帧 `motion_duration_s` 固定 0，Bridge 以独立 `preparation_duration_s` 从实测姿态准备到第一帧；首段执行成功并停稳后才开始组计时。后续帧的正 `motion_duration_s` 指前帧停留结束到该帧的运动轨迹时长，`hold_duration_s` 为该帧执行完成且停稳后的非负停留时长。名义时间轴包含运动与停留，准备、逐段规划及停稳确认单独计时，因此整组实际耗时可能超过名义时长。

- 完整原始 JSON（包含空白）限 256 KiB。`steps` 限 1–100 项，所有 ID 唯一、非空且最长 128 UTF-8 字节；标签最长 512 字节。准备、所有运动与停留合计不超过 604800 秒，所有数值须有限。入组校验所有后续帧的模型/关节及可选夹爪目标，当前段下发前继续复核实时门禁。
- 返回 `position_group_start_ack`，`accepted` 明确表示受理与否；失败包含 `message`。ACK 不代表准备完成、规划成功或实际到位。组内始终沿用同一 `command_id`，去重、会话归属、心跳和断线取消沿用现有运动入口。
- 复用 `position_motion` 推送，增加 `group_id`、从 0 开始的 `group_index`、`group_count`、`group_phase`（`preparing` / `moving` / `holding` / `paused`）及 `group_elapsed_s`。后者是准备完成后的实际累计时间，包含规划与停稳，暂停期间冻结。停留使用 `motion_phase:"waiting"`，实际暂停使用 `motion_phase:"paused"`；这两种状态继续持有全局运动锁。
- `position_group_pause` / `position_group_resume` 请求携带同一 `command_id`，仅允许拥有者操作；对应 `_ack` 的 `accepted` 表示请求是否受理。运动中暂停只预约在本段确认停稳后生效（ACK 可带 `pending:true`），以 `paused` 事件作为实际暂停证明。暂停冻结剩余停留时间，继续前重新校验门禁。
- `position_cancel` 取消整个动作组，包括准备、运动、停留与暂停。暂停或停留期间同样保留反馈/控制器/时钟/模型/租约检查；任一段失败或取消后均不得开始下一段。取消 ACK 仍不等于已停稳，`stop_failed` 保持锁定。
- 每段复用 MoveIt 规划、指定时长的完整轨迹校验与实际停稳确认；不会自动拉长不可行的指定时长，也不保证沿姿态间的笛卡尔直线运动。未编译 MoveIt 支持时返回对应拒绝 ACK 并广告不支持。

### 执行完成诊断

`position_motion_info` 及 `position_motion` 的 `position_error_check_enforced:false` 表示最终关节位置差值仅作诊断。Action 成功、反馈新鲜且机械臂/夹爪按既有速度阈值连续停稳 200 ms 才报告完成；独立 TCP Pose 检查保持有效。

组事件附带 `group_step_label`，来自本次执行快照。`position_motion.arrival_errors` 可含 1–7 个关节核验快照：`joint_name`、`target`、`actual`、`position_error`（actual−target）、`position_tolerance`（原参考值，非完成门槛）、`velocity`、`velocity_tolerance`、`unit`（rad 或 m）。数值须有限，关节唯一且与单位匹配；无新鲜有效反馈时省略。终态保存当时的核验快照，后续查询重放不重新计算，不表示当前实时反馈。

准备或一段执行完成后，若 `hold_duration_s:0` 且没有暂停预约，直接复用本段已完成的连续停稳核验推进或完成，不再进入下一 tick 的保持检查。真实停留/暂停以该时刻实测姿态为保持基准，位置漂移超过原容差立即取消；不重新使用名义目标位置差值作为转段门槛。速度短暂超过停稳阈值时进入 `motion_phase:"verifying"`，继续持锁并冻结剩余停留时间，重新连续停稳 200 ms 才恢复。自首次波动起 5 秒内仍未恢复则取消后续步骤，继续沿用原停止确认流程。暂停预约和所有反馈/控制器/时钟/模型/租约门禁仍生效。

相对保持基准漂移或持续未停稳失败时，`position_motion.hold_failure` 保存独立且不可变的触发快照：

```json
{"reason":"position_drift","phase":"holding","captured_at_ms":1793613261062,"feedback_age_ms":4,"stable_for_ms":0,"required_stable_ms":200,"samples":[{"joint_name":"joint3","target":-0.84,"actual":-0.81,"position_error":0.03,"position_tolerance":0.02,"velocity":0.04,"velocity_tolerance":0.03,"unit":"rad"}]}
```

`reason` 为 `position_drift` 或 `velocity_timeout`；`phase` 为失败时的 `holding` / `paused`。`captured_at_ms` 是 Jetson Unix 毫秒，`feedback_age_ms` 是该反馈的单调时钟年龄；可选的 `stable_for_ms` / `required_stable_ms` 描述恢复期限内有效的连续停稳确认时长。`samples` 沿用 `arrival_errors` 的有限值、关节及单位规则，但 `target` 是进入保持时的实测基准，`position_tolerance` 是实际漂移门槛。快照冻结后随取消和终态事件重放，与后续 `arrival_errors`（本帧名义目标与停止核验反馈）分别展示。持续停稳未满足时，触发快照中的瞬时速度也可能已低于阈值，不能据此断言某轴当时超速。缺失或无效时前端不沿用旧触发快照。


## 动作组相机 Action 与编辑轨道

`position_motion_info.motion_capture_supported:true` 广告拍照能力。缺失时桌面仍可编辑/保存，但不得发送含拍照 Action 的动作组。每个 `position_group_start.steps[]` 可附带 `captures`，在该 Pose 停稳且停留结束后按数组顺序采集：

```json
{"id":"pose-a","label":"标定姿态 01","positions":[0,0,0,0,0,0],"motion_duration_s":0,"hold_duration_s":1,"captures":[{"id":"capture-a","label":"拍照 01","type":"camera_capture","topic":"/camera/color/image_raw","timeout_s":5}]}
```

Action ID 为至多 128 字节的 ASCII 字母、数字、下划线或连字符，与全组 Pose/Action ID 不重复；类型必须为 `camera_capture`，名称至多 512 字节，Topic 为无空段的绝对 ROS Topic，超时为有限 0.1–60 秒。全组至多 100 个 Pose、100 个 Action，含准备、移动、停留及采集超时预算的总时间不超过 7 天。Bridge 在首次运动前验证全部字段；未知类型/字段、重复 ID 和无效参数明确拒绝。未提供 `captures` 的旧请求保持兼容。

采集期间 `motion_phase:"waiting"`、`group_phase:"holding"`，保留同一 command ID、租约和运动锁。只消费启动采集之后的新图像，图像及反馈源时间对 Jetson 时钟须在 -50..500 ms 内且彼此相差不超过 100 ms；格式和实际停稳/保持核验通过后异步编码。PNG 与反馈元数据先写入同一临时目录，再整体改名提交，已有采集目录拒绝覆盖。返回成功表示保存完成，不等同于手眼标定完成。

组事件可附带最近一次已提交的 `capture_result`，终态及后续状态查询可重放：

```json
{"id":"capture-a","name":"拍照 01","path":"/home/operator/.local/share/robot-console/captures/<command-id>/capture-a/image.png","image_stamp":1793613261.062,"joint_stamp":1793613261.060,"thumbnail":"<PNG base64>"}
```

缩略图最大边为 120 像素，仅用于结果预览；源图像保留在 Jetson，原有高频 Image 二进制路径不变。失败/取消不伪造成功结果，也不推进下一段。心跳、暂停、取消及所有既有门禁继续作用于采集阶段。

桌面动作组文件仍为 `motion-groups.v1.json`，兼容扩展 `tracks?:[{id,name,kind:"arm"|"camera",deviceId}]`、`steps[].trackId?`、`actions?:[{id,type:"camera_capture",name,trackId,afterStepId,topic,timeout}]`。省略轨道时使用 `{id:"arm",name:"机械臂",kind:"arm",deviceId:"current"}`。轨道及依赖在 TypeScript/Rust 两侧验证，序列化请求按依赖 Pose 转换为 `captures`；桌面另可保存 `syncPoints?:[{id,name,afterStepIds}]`；每个同步点需引用至少两个不同机械臂轨道的 Pose，ID 与 Pose/Action/同步点互不重复。时间轴位置表示参与 Pose 的名义完成时刻，不承诺真实同步。轨道与同步点均不作为多臂执行指令发送。当前多臂/非当前设备执行在客户端拒绝，Bridge 仍只有单机械臂调度能力。

### 同帧桌面物体检测

`hello.object_detection_supported` 表示当前 Bridge 是否编译了 PCL 检测组件。`subscribe_rgbd` 新增可选布尔字段 `detect_objects`（默认 false）。true 要求 `target_frame: "base_link"` 且组件可用；类型错误、配置错误或不支持时返回关联 `request_id` 的 `error`，不替换已有订阅。检测开启时实际 `max_fps` 不超过 10。老客户端仍收到原有 RGBD；新客户端在老 Bridge 上禁用检测。

开启检测后，每个有效 `RCD1` 帧元数据增加 `objects`，与该帧的深度、内参、采集时刻 TF 和订阅令牌一致，不另发异步检测包：

```json
{"objects":{"status":"ok","message":"可见点云包围盒","frame_seq":1,"items":[{"id":1,"center":[0.2,0.1,0.05],"size":[0.05,0.06,0.04],"point_count":120}]}}
```

`center/size` 为 `base_link` 轴对齐包围盒中心/完整边长，单位米；`point_count` 为该体素聚类点数。`frame_seq` 在订阅内递增；ID 在当前订阅内通过多帧匹配保留：连续 3 帧确认后分配，短暂漏检保留内部记录最多 1.5 秒，漏检时不发送旧框；确认前返回 empty，消息提示候选确认中。不跨重连或时钟代次保证。`status` 为 `ok` / `empty` / `no_table` / `error`，后三种 `items` 必须为空。最多 20 个框。检测失败仍可携带有效点云，不能保留上一帧框。桌面不可信时不聚类整个场景。源帧龄在检测完成后计算，超过原有 500 ms 源期限不发送。客户端对有限坐标、尺寸范围、重复 ID、状态和数量进行校验，非法对象数据显示错误并清空框。RGBD 整体失败继续使用原有 `tf_ok:false` 清除整个帧。

## 视觉 Pick（分段闭环）

`hello.visual_pick_supported:true` 表示支持选择预览和服务端执行编排，不代表标定或运动已经就绪。客户端仅发送当前 RGBD 订阅的 ID，不提供任意 ROS Topic、TCP 位姿或抓取配置文件路径。

- 预览：`{"op":"visual_pick_preview","request_id":"uuid","subscription_id":"RGBD-token","object_id":1}`。要求同一客户端正在订阅带检测的 `base_link` RGBD，目标当前可见，源帧龄小于 500 ms，时钟代次匹配。返回 `visual_pick_preview`，包含原令牌/编号、`frame_seq`、`calibrated`、`execution_ready`、`grasp/pregrasp`（各含三个米制 position 和 xyzw orientation）、`opening_m`（单指行程）、`message`。未标定的姿态是抓取坐标系几何候选，不是可执行 TCP。
- 开始：`{"op":"visual_pick_start","request_id":"uuid","subscription_id":"RGBD-token","object_id":1,"preview_frame_seq":12,"command_id":"UUID","confirmation":"ARMED"}`。command_id 仅允许字母、数字、连字符，最长 60 字符，最近 256 个受理 ID 去重。要求最近 1 秒内同一客户端生成的可执行预览，当前目标/时间代次一致、中心偏移不超过 2 cm、每轴尺寸变化不超过 1 cm、抓取配置一致，且标定/场景核验均通过；后台再核验 MoveIt TCP、夹爪可用性与标定开度。返回关联 request_id 的 `visual_pick_state`，busy:true 表示任务已受理，不代表规划或抓取成功。
- 状态/心跳：`{"op":"visual_pick_status","request_id":"uuid"}`。只有任务所属客户端刷新其 3 秒心跳；建议 500 ms 查询一次。返回 `visual_pick_state`，含 `command_id`、`pick_phase`、`message`、`busy`。`pick_phase` 不复用重力辨识的数字 `phase` 字段。
- 取消：`{"op":"visual_pick_cancel","request_id":"uuid"}`。只有所属客户端可以取消在执行任务；返回当前状态。不会把取消受理当作停稳。会话断开、DISABLE、取消和错误都禁止继续下发后续段。

阶段为 idle / validating / opening / approaching / descending / closing / lifting / holding / canceling / stop_failed / failed / canceled。异步状态也使用 `visual_pick_state`。holding 表示抬升运动完成并保持，不构成夹持成功证明。规划/执行通过既有 `PositionMotion` 的受限 TCP/夹爪接口，保留其碰撞、模型、时序、反馈、控制器及停稳确认。停止未确认时 busy 保持 true；正常终态才释放视觉运动锁。期间普通 position_move、动作组启动/继续、非 DISABLE 直接命令、轨迹发布及重力辨识被拒绝。未知、重复、非标量请求字段返回 error。
