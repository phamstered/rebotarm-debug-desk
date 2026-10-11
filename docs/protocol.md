# Bridge protocol v0.1

Messages are UTF-8 JSON WebSocket text frames.

## Requests

```json
{"op":"hello"}
```

```json
{"op":"topics","request_id":"uuid"}
```

```json
{"op":"graph","request_id":"uuid"}
```

```json
{"op":"subscribe","request_id":"uuid","topic":"/joint_states","type":"sensor_msgs/msg/JointState"}
```

```json
{"op":"resource","request_id":"uuid","uri":"package://robot_description/meshes/base.stl"}
```

MIT joint command:

```json
{
  "op":"joint_command",
  "request_id":"uuid",
  "mode":1,
  "position":0.1,
  "velocity":0.0,
  "kp":8.0,
  "kd":2.0,
  "effort":0.0,
  "confirmation":"ARMED"
}
```

HOLD、TRACK和RETURN必须携带 `confirmation: "ARMED"`。DISABLE忽略输入值并将所有通道写零。

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
