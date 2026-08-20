---
title: Robot Console 上位机架构
aliases:
  - ROS2 Debug 上位机架构
  - Robot Console Architecture
  - Easy Debug Architecture
date: 2026-08-09
updated: 2026-08-20
status: active
tags:
  - project/robot-console
  - project/easy-debug
  - ros2/humble
  - tauri
  - robot/debug
related:
  - "[[leader_follower 项目概述]]"
  - "[[设备拓扑与通信]]"
---

# Robot Console 上位机架构

Robot Console 是运行在 macOS Apple Silicon 上的 ROS 2 Humble 调试与受控操作上位机。Mac 不安装 ROS 2，也不直接加入 DDS 网络；Topic 数据和控制命令由 Jetson Bridge 转发，ROS Control 状态通过 Jetson 上的 `ros2 control` CLI 只读查询。

> [!info] 当前部署
> - Mac：Tauri v2 + Rust + React + TypeScript + Three.js
> - Jetson：Ubuntu 22.04 + ROS 2 Humble + Fast DDS
> - Bridge：`127.0.0.1:8765`
> - Mac本地转发：`127.0.0.1:18765`
> - SSH配置：`damiao`
> - micro-ROS Agent：`micro-ros-agent-stm32h723.service`

## 总体架构

```mermaid
flowchart LR
    subgraph MAC["macOS · Robot Console.app"]
        UI["React 工作区"]
        CONNECTION["连接配置与 Agent 状态"]
        TOPIC["Topic Browser / Inspector"]
        ROSCONTROL["ROS Control 状态列表"]
        URDF["Three.js URDF Viewer"]
        CONTROL["MIT 电机控制面板"]
        TAURI["Tauri Rust 后端"]
        SSH["SSH 会话与本地端口转发"]

        UI --> CONNECTION
        UI --> TOPIC
        UI --> ROSCONTROL
        UI --> URDF
        UI --> CONTROL
        CONNECTION --> TAURI
        ROSCONTROL --> TAURI
        TAURI --> SSH
    end

    subgraph JETSON["Jetson · Ubuntu 22.04"]
        BRIDGE["easy_debug_bridge · rclcpp + Boost.Beast"]
        GRAPH["ROS Graph / 标准与自定义消息编解码"]
        RESOURCE["ament package:// 资源解析"]
        GUARD["MIT 命令安全预检与序列号"]
        FASTDDS["ROS 2 Humble · Fast DDS"]
        AGENT["micro-ROS Agent · systemd"]
        ROSNODES["leader_follower ROS节点与插件"]
        CONTROLCLI["ros2 control CLI"]

        BRIDGE --> GRAPH
        BRIDGE --> RESOURCE
        BRIDGE --> GUARD
        GRAPH <--> FASTDDS
        GUARD --> FASTDDS
        ROSNODES <--> FASTDDS
        CONTROLCLI <--> FASTDDS
        AGENT <--> FASTDDS
    end

    subgraph MCU["STM32H723 + Damiao"]
        XRCE["Micro XRCE-DDS Client"]
        FW["motor_bridge 安全状态机"]
        CAN["FDCAN / Damiao MIT"]
        MOTOR["joint1 电机"]

        XRCE <--> FW
        FW --> CAN
        CAN <--> MOTOR
    end

    SSH <-->|"加密隧道 · WebSocket JSON"| BRIDGE
    SSH <-->|"每5秒只读查询"| CONTROLCLI
    URDF <-->|"URDF XML + Mesh资源"| BRIDGE
    TOPIC <-->|"只读 Topic 数据"| BRIDGE
    CONTROL -->|"20 Hz JointCommand"| BRIDGE
    AGENT <-->|"USB Serial · 921600 baud"| XRCE
```

## 连接时序

```mermaid
sequenceDiagram
    participant UI as "Robot Console UI"
    participant Rust as "Tauri Rust"
    participant SSH as "ssh damiao"
    participant Systemd as "systemd"
    participant Bridge as "easy_debug_bridge"
    participant ROS as "ROS 2 Graph"

    UI->>Rust: 读取连接 Profile
    Rust->>SSH: BatchMode连接检查
    SSH-->>Rust: easy-debug-ready
    Rust->>Systemd: systemctl show micro-ros-agent-stm32h723.service
    Systemd-->>UI: active / running / PID / enabled
    Rust->>SSH: 检查或启动 Bridge
    Rust->>SSH: 建立 18765 → 8765 端口转发
    UI->>Bridge: WebSocket hello
    UI->>Bridge: topics
    Bridge->>ROS: get_topic_names_and_types
    ROS-->>UI: Topic名称与消息类型
    UI->>Bridge: 订阅 URDF、JointState、HardwareStatus
    loop 每5秒
        UI->>Rust: check_ros_controllers
        Rust->>SSH: ros2 control list_controllers
        SSH-->>UI: Controller名称、类型和状态
    end
```

## 主要数据流

| 方向 | Topic / 接口 | 类型 | 用途 |
|---|---|---|---|
| ROS → UI | `/robot_description` | `std_msgs/msg/String` | URDF XML |
| ROS → UI | `/stm32/joint_states` | `sensor_msgs/msg/JointState` | 三维模型驱动与实时反馈 |
| ROS → UI | `/stm32/status` | `microros_stm32h723_bridge/msg/HardwareStatus` | 模式、序列号、active mask、故障码 |
| UI → ROS | `/stm32/joint_commands` | `microros_stm32h723_bridge/msg/JointCommand` | MIT 电机控制命令 |
| UI ↔ Bridge | WebSocket JSON | Easy Debug Protocol v0.1 | Topic发现、订阅、资源及命令 |
| ROS → UI | `/controller_manager/list_controllers` | ROS Control service / CLI | 已加载 Controller 的名称、类型和状态 |
| Bridge → UI | `package://...` | STL / DAE / OBJ / Texture | URDF网格与材质资源 |

XRCE-DDS 设备通过 micro-ROS Agent 映射到 Fast DDS graph，上位机不需要单独识别 XRCE实体。相关底层拓扑参见 [[设备拓扑与通信]]。

## URDF 渲染链路

```mermaid
flowchart LR
    DESCRIPTION["/robot_description · std_msgs/String"] --> BRIDGE["Bridge"]
    BRIDGE --> XML["URDF XML"]
    XML --> PARSER["urdf-loader"]
    XML --> URI["提取 package:// URI"]
    URI --> AMENT["Jetson ament_index_cpp"]
    AMENT --> ASSET["STL / DAE / OBJ / Texture"]
    ASSET --> BLOB["Mac Blob URL缓存"]
    BLOB --> THREE["Three.js Scene"]
    JOINTS["/stm32/joint_states"] --> THREE
```

DAE中的相对纹理路径会先在 Jetson解析并传输，再替换为本地 Blob URL。Bridge 对资源路径执行 canonicalize，并拒绝越过 package目录的请求。

## MIT 电机控制链路

```mermaid
flowchart TD
    FORM["用户输入 position / velocity / Kp / Kd / effort"] --> ARM{"安全确认已解锁？"}
    ARM -->|"否"| REJECT1["拒绝发送"]
    ARM -->|"是"| LIMIT{"Effort在±1 Nm内？"}
    LIMIT -->|"否"| REJECT2["拒绝并显示错误"]
    LIMIT -->|"是"| PREFLIGHT{"Bridge预检"}
    PREFLIGHT --> CHECKS["subscriber存在<br/>status与feedback新鲜<br/>joint1 active"]
    CHECKS -->|"失败"| REJECT3["停止命令流"]
    CHECKS -->|"通过"| STREAM["20 Hz JointCommand"]
    STREAM --> TOPIC["/stm32/joint_commands"]
    TOPIC --> AGENT["micro-ROS Agent"]
    AGENT --> MCU["STM32 motor_bridge"]
    MCU --> MIT["Damiao MIT CAN Frame"]
    MIT --> FEEDBACK["JointState + HardwareStatus"]
    FEEDBACK --> PREFLIGHT
    STOP["停止并 DISABLE"] --> DISABLE["重复发送3次 MODE_DISABLE"]
    DISABLE --> TOPIC
```

### `JointCommand.mode`

| 值 | 模式 | 当前固件行为 |
|---:|---|---|
| `0` | HOLD | 锁存当前反馈位置，使用 Kp/Kd 保持 |
| `1` | TRACK | MIT跟踪 position、velocity、Kp、Kd、effort |
| `2` | RETURN | MIT跟踪返回目标，通常为 `0 rad` |
| `3` | DISABLE | 撤销电机使能，所有命令通道写零 |

> [!danger] 控制边界
> 当前固件仅激活 joint1，`active_joint_mask = 0x01`。Bridge 强制把 joint2–joint7 的 position、velocity、Kp、Kd和effort全部写零，避免触发 `MOTOR_FAULT_INACTIVE_JOINT_COMMAND`。

### 上位机限幅

| 参数 | 上位机与 Bridge 限制 |
|---|---:|
| Position | 不限制；由 STM32 固件最终校验 |
| Velocity | 不限制；由 STM32 固件最终校验 |
| Kp | 不限制；由 STM32 固件最终校验 |
| Kd | 不限制；由 STM32 固件最终校验 |
| Effort | `±1 Nm` |

停止20 Hz命令流后，STM32固件在 `100 ms` 后进入 HOLD，在 `500 ms` 后进入 DISABLE。界面“停止并 DISABLE”不要求解锁；连接在控制期间主动断开时也会先请求 DISABLE。

## 故障与降级

> [!warning] Fail-safe行为
> - SSH或WebSocket断开：命令流停止，由固件超时进入 HOLD → DISABLE。
> - micro-ROS Agent未运行：顶部状态标识变红，Bridge因无 command subscriber拒绝控制。
> - status或joint feedback超过1秒：Bridge拒绝非 DISABLE 指令。
> - `fault_code != 0`：UI显示 fault 名称和中文详情，STM32固件决定是否接受命令。
> - controller manager不可用：ROS Control列表显示离线，Topic、URDF和电机控制界面继续工作。
> - URDF mesh丢失：仅影响对应 visual，Topic检查和控制链路仍可使用。

## 代码位置

| 模块 | 路径 |
|---|---|
| React工作区 | `/Users/jialiang/Project/easy_debug/src/App.tsx` |
| MIT控制面板 | `/Users/jialiang/Project/easy_debug/src/MotorControl.tsx` |
| URDF渲染 | `/Users/jialiang/Project/easy_debug/src/UrdfViewer.tsx` |
| Tauri SSH后端 | `/Users/jialiang/Project/easy_debug/src-tauri/src/lib.rs` |
| ROS Bridge | `/Users/jialiang/Project/easy_debug/bridge/easy_debug_bridge/src/bridge_node.cpp` |
| ROS消息定义 | `/Users/jialiang/Project/leader_follower/src/plugin/microros_stm32h723_bridge/msg` |
| STM32控制状态机 | `/Users/jialiang/Project/rebotarm_executor/User/motor_bridge.c` |

## 后续演进

- [ ] 将 Bridge改为独立 systemd用户服务并增加版本检查
- [ ] Topic数值曲线和字段选择器
- [ ] TF树与坐标系显示
- [ ] 多关节 active mask控制
- [ ] Bridge二进制自动部署与升级
- [ ] 网格资源流式传输和磁盘缓存
