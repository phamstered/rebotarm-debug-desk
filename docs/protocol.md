# Bridge protocol v0.1

WebSocket protocol between the **Rebotarm Debug Desk** desktop (repo [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)) and the Jetson `easy_debug_bridge`.

Messages are UTF-8 JSON WebSocket text frames.

## Requests

```json
{"op":"hello"}
```

Hello response (sent immediately after the request):

```json
{"op":"hello","bridge_version":"0.1.0","bridge_build_id":"8a023e7a0bad","ros_distro":"humble"}
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
