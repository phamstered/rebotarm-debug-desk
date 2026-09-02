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

除若干界面专用类型外，Bridge 通过 ROS 2 C++ introspection 自动解码消息。`data` 会递归保留消息定义中的字段、嵌套对象和数组；非有限浮点数编码为 JSON `null`，64 位整数编码为十进制字符串以避免 JavaScript 精度损失。消息类型无需预先登记，但其消息包和 introspection typesupport 必须安装在 Jetson ROS 环境中。单条消息解码失败时，事件数据为 `{"_decode_error":"原因"}`，不会中断订阅。

Joint trajectory data:

```json
{
  "op":"topic_message",
  "topic":"/arm_controller/joint_trajectory",
  "data":{
    "header":{"stamp":{"sec":0,"nanosec":0},"frame_id":"base_link"},
    "joint_names":["joint1","joint2"],
    "points":[{
      "positions":[0.2,-0.1],
      "velocities":[0.5,0.5],
      "accelerations":[],
      "effort":[],
      "time_from_start":{"sec":1,"nanosec":500000000}
    }]
  }
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
