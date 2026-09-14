# Robot Console 基本功能与测试覆盖

更新日期：2026-09-14

本文档记录当前已经实现的基本功能、运行边界以及对应的自动化单元测试。项目由 macOS Tauri 桌面端、React/Three.js WebView 和 Jetson ROS 2 Bridge 三部分组成。

## 1. 连接与会话

- 保存并恢复连接配置：SSH 主机、用户名、端口、私钥、ROS Domain、ROS 环境脚本及各 ROS Topic。
- 自动迁移旧配置：旧 ROS setup 路径和 `/joint_states` 会迁移到当前默认值 `/stm32/joint_states`。
- 依次执行 SSH 检查、micro-ROS Agent 状态检查、Jetson Bridge 启动、SSH 本地端口转发和 WebSocket 连接。
- 首选本地端口被占用时自动选择空闲端口，并在界面显示实际转发端口。
- 断开连接时关闭 WebSocket、SSH 隧道；电机命令流运行时先请求 DISABLE。
- 断开和重新连接时清空上一会话的 Topic 列表与采样、选中项、URDF、JointState、硬件/Agent/Controller 状态、错误及操作反馈；保留连接配置、面板布局等用户偏好。
- Bridge 关闭时拒绝上一会话尚未完成的请求，并忽略旧 WebSocket 延迟到达的数据帧，避免污染新会话。
- Jetson Bridge 仅监听 `127.0.0.1`，通过 SSH 隧道访问。

## 2. micro-ROS Agent 状态

- 读取 `micro-ros-agent-stm32h723.service` 的 systemd 状态。
- 显示 loaded/active/substate、PID、开机启用状态和服务描述。
- 连接后每 5 秒刷新，区分运行中、未运行和检查失败。

## 3. ROS Topic 浏览器

- 从 ROS graph 获取 Topic 名称和类型。
- 点击 Topic 后创建只读订阅，并以 JSON 查看最新消息。
- 显示累计消息数和平均接收频率。
- Topics 列表头部提供即时搜索框，可按 Topic 名称或消息类型进行大小写不敏感过滤，并显示匹配数/总数；过滤仅影响本地显示，不改变订阅状态。
- Topics 列表默认每 30 秒重新请求 ROS graph，也可通过标题栏刷新按钮立即刷新；刷新失败时保留现有列表并显示原因。
- Topics、ROS Control、Motor Control、Topic Inspector 四个区域可独立展开/收起，状态保存在本机；同一侧的另一个面板会自动使用释放出的高度。
- Topics/ROS Control 和 Motor Control/Topic Inspector 之间可上下拖动调整高度；左右侧栏边界可横向拖动调整宽度，面板尺寸会持久化到本机。分隔条支持键盘方向键微调。
- Topics 下方显示 `/controller_manager` 当前加载的 ROS Control Controller、类型及 active/inactive 等状态，每 30 秒只读刷新。
- ROS Control 标题栏提供手动刷新按钮，与展开/收起按钮并列；手动与自动刷新具有并发保护。
- 每个 Controller 可根据当前状态执行 Activate 或 Deactivate；操作通过 SSH 调用 Humble `ros2 control switch_controllers --strict`，完成后固定刷新一次列表并展示成功或错误信息。
- Controller 名称和操作类型在 Tauri/Rust 后端校验，拒绝包含 shell 特殊字符的输入。
- 兼容 Jetson 当前 Humble `ros2controlcli` 的超时参数类型缺陷：不显式传入 `--switch-timeout`，使用其内部浮点默认值，并由外层进程提供 10 秒超时保护。
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

## 4. Topic Graph 与 Topic Inspector jq 过滤

- Robot View 同级提供 Topic Graph Tab，展示 ROS Node、Topic，以及 Publisher/Subscriber 的有向连接关系，视觉语义与 `rqt_graph` 一致。
- Topic Graph 在打开时立即加载，默认每 30 秒自动刷新，也可点击“刷新 Graph”手动刷新；图变化不影响现有 Topic 数据订阅。
- Graph 使用 Sugiyama 分层图的重心排序：Publisher 倾向左侧、Topic 居中、Subscriber 倾向右侧，通过多轮相邻层扫描减少连线交叉，并按相邻 Topic 平均位置对齐 ROS Node。
- 点击任意节点会高亮其一跳关联节点和连线、弱化其他拓扑；点击 Topic 节点还会创建只读订阅，并将该 Topic 送入右侧 Topic Inspector。
- jq 编辑器和结果位于 Topic Inspector。每个 Topic 可配置独立表达式；使用浏览器内嵌的 jq 1.8.2 WASM，支持管道、字段选择、数组、`select` 等标准 jq 语法，不依赖 Jetson 安装 jq。
- jq 表达式按 Topic 持久化在本机；默认留空且直接显示原始 JSON，仅在填写表达式后按需加载 jq WASM。语法错误、订阅失败与空输出分别显示，不会中断 Graph 刷新。
- jq 使用固定频率处理最新一帧 Topic 数据；高频消息不会反复重置表达式防抖，因此 JointState 等持续数据流也能稳定刷新筛选结果。
- Graph 可以展示 ROS graph 中的全部 Topic，但实时数据仍受 Bridge 消息类型注册表限制；不支持解码的消息类型会明确提示订阅失败。

## 5. URDF 与 Three.js

- 从配置的 `std_msgs/msg/String` Topic 获取 URDF XML。
- Bridge 对名称末段为 `/robot_description` 的 Topic 固定使用 `RELIABLE + TRANSIENT_LOCAL + KeepLast(1)` 订阅，不依赖 ROS graph 发现时序；即使 `robot_state_publisher` 仅在启动时发布一次，晚连接的上位机也能取得 DDS 保留的 URDF。
- 使用 Three.js、React Three Fiber 和 `urdf-loader` 渲染机器人。
- 保留 URDF `<visual>` 的内联或全局命名 RGBA 材质颜色；异步 STL、DAE、OBJ 网格挂载后再应用颜色，并保留网格纹理等材质属性。
- Robot View 使用平衡的环境光和方向光，避免中间色机械臂因过曝显示成白色。
- 根据 `sensor_msgs/msg/JointState` 的 name/position 驱动 URDF 关节；缺少的位置值按 0 处理。
- 通过 Bridge 获取 `package://` 资源，支持 STL、DAE、OBJ、PNG、JPG/JPEG。
- 解析 DAE 相对纹理路径，生成临时 Blob URL，并在资源释放时回收 URL。
- Bridge 对 package 资源执行规范路径检查，禁止越过 package share 目录。
- 大型 URDF 网格采用顺序加载，避免多个 Base64 WebSocket 响应同时排队；单个资源使用 30 秒超时，并在失败提示中显示具体 `package://` URI。
- Tauri CSP 同时允许 Three.js 通过 `connect-src blob:` 获取 STL/DAE/OBJ Blob；网格解析失败时显示 Blob 路径和底层错误原因。

## 6. MIT 电机控制

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

## 7. WebSocket 协议

- 使用 UTF-8 JSON 文本帧。
- 支持 hello、topics、graph、subscribe、resource、joint_command 操作。
- request 使用 UUID 与 response/error 关联，超时或 Bridge error 会拒绝 Promise。
- Bridge 断开会通知界面进入连接失败状态。
- 完整字段参见 [protocol.md](protocol.md)。

## 8. App 品牌与图标

- 应用名称为 Robot Console。
- App Logo 使用简化双关节机械臂、金属材质和单一青色状态光，适配深色界面与 macOS Dock 小尺寸显示。
- 设计源文件位于 `assets/logo/robot-console-icon.png`，应用内品牌图和 Tauri macOS Bundle 共用同一视觉资源。

## 9. 单元测试覆盖矩阵

| 功能域 | 覆盖内容 | 测试位置 |
|---|---|---|
| 配置 | 默认值、损坏数据回退、旧路径/Topic 迁移 | `src/appLogic.test.ts` |
| 面板 | 默认/持久化状态、四个面板独立收起、宽高分隔条和尺寸边界 | `src/appLogic.test.ts`、`src/layoutLogic.test.ts`、`src/App.test.tsx` |
| 连接流程 | SSH→Agent→隧道→Bridge、实际端口、基础订阅、重连会话数据清理 | `src/App.test.tsx`、`src/bridge.test.ts` |
| Agent | systemd 属性解析、异常 PID | `src-tauri/src/lib.rs` |
| SSH 输入 | 用户名目标、setup 路径和 Topic 格式校验 | `src-tauri/src/lib.rs` |
| 本地端口 | 首选端口及占用时自动回退 | `src-tauri/src/lib.rs` |
| Topic | 发现、选择订阅、消息路由、计数和频率、手动/30 秒自动刷新 | `src/App.test.tsx`、`src/appLogic.test.ts` |
| Topic Graph | ROS 图请求、Sugiyama 重心排序和交叉消除、Publisher/Subscriber 方向、节点聚焦、Tab 与节点订阅、手动/30 秒刷新 | `src/bridge.test.ts`、`src/topicGraphLogic.test.ts`、`src/TopicGraph.test.tsx`、`src/App.test.tsx` |
| Topic Inspector jq | 默认原始 JSON、jq 1.8.2 WASM 实际执行、管道/选择、单/多/空结果格式和表达式持久化 | `src/jqFilter.test.ts`、`src/topicInspectorLogic.test.ts`、`src/TopicInspector.test.tsx`、`src/App.test.tsx` |
| ROS Control | CLI 输出解析、ANSI 清理、超时说明、Controller 状态展示、Activate/Deactivate、操作后刷新、手动/30 秒自动刷新 | `src-tauri/src/lib.rs`、`src/App.test.tsx` |
| WebSocket | hello、发送状态、请求关联、错误、断开 | `src/bridge.test.ts` |
| URDF | transient-local 晚加入 QoS、package URI、相对纹理、Base64、JointState 映射、内联/命名材质颜色、异步网格挂载后着色 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp`、`src/urdfLogic.test.ts` |
| 电机输入 | 默认 TRACK/Kp/Kd、小数输入、有效数值和 Effort 限制 | `src/motorLogic.test.ts` |
| 电机交互 | 安全确认、使用当前位置、20 Hz 流、DISABLE | `src/MotorControl.test.tsx` |
| Fault | 固件 0–11 映射及未知 fault | `src/motorLogic.test.ts`、`src/MotorControl.test.tsx` |
| Bridge 命令 | mode、ARMED、有限值、Effort 及 sequence 分配 | `bridge/easy_debug_bridge/test/test_bridge_core.cpp` |

## 10. 测试命令

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
