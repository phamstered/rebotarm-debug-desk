# Robot Console 基本功能与测试覆盖

更新日期：2026-08-20

本文档记录当前已经实现的基本功能、运行边界以及对应的自动化单元测试。项目由 macOS Tauri 桌面端、React/Three.js WebView 和 Jetson ROS 2 Bridge 三部分组成。

## 1. 连接与会话

- 保存并恢复连接配置：SSH 主机、用户名、端口、私钥、ROS Domain、ROS 环境脚本及各 ROS Topic。
- 自动迁移旧配置：旧 ROS setup 路径和 `/joint_states` 会迁移到当前默认值 `/stm32/joint_states`。
- 依次执行 SSH 检查、micro-ROS Agent 状态检查、Jetson Bridge 启动、SSH 本地端口转发和 WebSocket 连接。
- 首选本地端口被占用时自动选择空闲端口，并在界面显示实际转发端口。
- 断开连接时关闭 WebSocket、SSH 隧道；电机命令流运行时先请求 DISABLE。
- Jetson Bridge 仅监听 `127.0.0.1`，通过 SSH 隧道访问。

## 2. micro-ROS Agent 状态

- 读取 `micro-ros-agent-stm32h723.service` 的 systemd 状态。
- 显示 loaded/active/substate、PID、开机启用状态和服务描述。
- 连接后每 5 秒刷新，区分运行中、未运行和检查失败。

## 3. ROS Topic 浏览器

- 从 ROS graph 获取 Topic 名称和类型。
- 点击 Topic 后创建只读订阅，并以 JSON 查看最新消息。
- 显示累计消息数和平均接收频率。
- Topics 列表默认每 30 秒重新请求 ROS graph，也可通过标题栏刷新按钮立即刷新；刷新失败时保留现有列表并显示原因。
- Topics、ROS Control、Motor Control、Topic Inspector 四个区域可独立展开/收起，状态保存在本机；同一侧的另一个面板会自动使用释放出的高度。
- Topics/ROS Control 和 Motor Control/Topic Inspector 之间可上下拖动调整高度；左右侧栏边界可横向拖动调整宽度，面板尺寸会持久化到本机。分隔条支持键盘方向键微调。
- Topics 下方显示 `/controller_manager` 当前加载的 ROS Control Controller、类型及 active/inactive 等状态，每 30 秒只读刷新。
- ROS Control 标题栏提供手动刷新按钮，与展开/收起按钮并列；手动与自动刷新具有并发保护。
- controller manager 服务不可用或查询超时时显示离线原因，不阻塞 Topic 浏览和其他功能。
- 当前 Bridge 支持以下消息内容：

  - `std_msgs/msg/String`
  - `std_msgs/msg/Bool`
  - `std_msgs/msg/Float32`
  - `std_msgs/msg/Float64`
  - `std_msgs/msg/Int32`
  - `std_msgs/msg/UInt32`
  - `std_msgs/msg/Float32MultiArray`
  - `std_msgs/msg/Float64MultiArray`
  - `sensor_msgs/msg/JointState`
  - `microros_stm32h723_bridge/msg/JointCommand`
  - `microros_stm32h723_bridge/msg/HardwareStatus`

## 4. URDF 与 Three.js

- 从配置的 `std_msgs/msg/String` Topic 获取 URDF XML。
- 使用 Three.js、React Three Fiber 和 `urdf-loader` 渲染机器人。
- 根据 `sensor_msgs/msg/JointState` 的 name/position 驱动 URDF 关节；缺少的位置值按 0 处理。
- 通过 Bridge 获取 `package://` 资源，支持 STL、DAE、OBJ、PNG、JPG/JPEG。
- 解析 DAE 相对纹理路径，生成临时 Blob URL，并在资源释放时回收 URL。
- Bridge 对 package 资源执行规范路径检查，禁止越过 package share 目录。

## 5. MIT 电机控制

- 发布 Topic 默认为 `/stm32/joint_commands`，消息类型为 `JointCommand`。
- 默认模式为 TRACK，默认 `Kp=8`、`Kd=2`。
- 支持 HOLD、TRACK、RETURN、DISABLE 四种 `JointCommand.mode`。
- Position、Velocity、Kp、Kd 不由上位机限幅；Effort 限制为 `[-1, 1] Nm`，所有字段必须为有限数字。
- 允许自然输入负数、小数、输入中的末尾小数点以及逗号小数。
- “使用当前位置”是唯一会把反馈位置写入 Position 的操作。
- 安全确认在一次连接会话中只需勾选一次；DISABLE 后不会自动取消。
- TRACK 等非 DISABLE 命令预检成功后以 20 Hz 连续发送。
- Bridge 要求 command subscriber、最新 status/joint feedback 和 joint1 active；STM32 fault 由界面展示，最终执行安全由固件裁决。
- DISABLE 将控制字段清零并发布 3 帧，各帧使用连续递增的 sequence，避免 `STALE_SEQUENCE`。
- 显示 STM32 fault code 0–11 的英文名称和中文原因；未知编号显示 UNKNOWN。

> STM32 固件仍有自己的最终限幅。例如当前固件 Position 上限为 `±0.35 rad`，`pos=0.6` 会被固件报告为 `FAULT 3 · COMMAND_LIMIT`。

## 6. WebSocket 协议

- 使用 UTF-8 JSON 文本帧。
- 支持 hello、topics、subscribe、resource、joint_command 操作。
- request 使用 UUID 与 response/error 关联，超时或 Bridge error 会拒绝 Promise。
- Bridge 断开会通知界面进入连接失败状态。
- 完整字段参见 [protocol.md](protocol.md)。

## 7. App 品牌与图标

- 应用名称为 Robot Console。
- App Logo 使用简化双关节机械臂、金属材质和单一青色状态光，适配深色界面与 macOS Dock 小尺寸显示。
- 设计源文件位于 `assets/logo/robot-console-icon.png`，应用内品牌图和 Tauri macOS Bundle 共用同一视觉资源。

## 8. 单元测试覆盖矩阵

| 功能域 | 覆盖内容 | 测试位置 |
|---|---|---|
| 配置 | 默认值、损坏数据回退、旧路径/Topic 迁移 | `src/appLogic.test.ts` |
| 面板 | 默认/持久化状态、四个面板独立收起、宽高分隔条和尺寸边界 | `src/appLogic.test.ts`、`src/layoutLogic.test.ts`、`src/App.test.tsx` |
| 连接流程 | SSH→Agent→隧道→Bridge、实际端口、基础订阅 | `src/App.test.tsx` |
| Agent | systemd 属性解析、异常 PID | `src-tauri/src/lib.rs` |
| SSH 输入 | 用户名目标、setup 路径和 Topic 格式校验 | `src-tauri/src/lib.rs` |
| 本地端口 | 首选端口及占用时自动回退 | `src-tauri/src/lib.rs` |
| Topic | 发现、选择订阅、消息路由、计数和频率、手动/30 秒自动刷新 | `src/App.test.tsx`、`src/appLogic.test.ts` |
| ROS Control | CLI 输出解析、ANSI 清理、超时说明、Controller 名称/类型/状态展示、手动/30 秒自动刷新 | `src-tauri/src/lib.rs`、`src/App.test.tsx` |
| WebSocket | hello、发送状态、请求关联、错误、断开 | `src/bridge.test.ts` |
| URDF | package URI、相对纹理、Base64、JointState 映射 | `src/urdfLogic.test.ts` |
| 电机输入 | 默认 TRACK/Kp/Kd、小数输入、有效数值和 Effort 限制 | `src/motorLogic.test.ts` |
| 电机交互 | 安全确认、使用当前位置、20 Hz 流、DISABLE | `src/MotorControl.test.tsx` |
| Fault | 固件 0–11 映射及未知 fault | `src/motorLogic.test.ts`、`src/MotorControl.test.tsx` |
| Bridge 命令 | mode、ARMED、有限值、Effort 及 sequence 分配 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |

## 9. 测试命令

每次功能变更必须执行：

```bash
npm test
npm run build
```

`npm test` 顺序执行：

1. `npm run test:frontend`：Vitest + jsdom + Testing Library。
2. `npm run test:rust`：Tauri/Rust 原生单元测试。
3. `npm run test:bridge`：不依赖 ROS 安装的 Bridge 核心 C++ 单元测试。

Jetson、Fast DDS、micro-ROS Agent 和 STM32 属于外部进程/硬件边界，不能由本机单元测试替代。涉及这些边界的变更还需执行 ROS 2 `colcon test`、隔离测试 Topic 或安全的 DISABLE 验证，但外部验证不能取代上述全量单元测试。
