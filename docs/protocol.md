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


