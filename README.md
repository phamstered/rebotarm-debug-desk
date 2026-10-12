# Robot Debug Desk

macOS 上的 ROS 2 Humble 调试与受控操作控制台（Tauri + React + Three.js）。桌面端通过 **SSH 隧道** 连接 Jetson 上的 WebSocket Bridge；**Mac 不安装、不加入本地 ROS / DDS**。

| | |
|---|---|
| **产品名** | Robot Debug Desk |
| **仓库** | [`phamstered/robot-debug-desk`](https://github.com/phamstered/robot-debug-desk) |
| **npm 包名** | `easy-debug`（历史名，尚未改代码） |
| **应用显示名** | Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`） |

> 本文档以 **Robot Debug Desk** 作为用户面向产品名；包名与 `.app` 显示名以当前代码为准，不会在文档 PR 中静默改名。

## 架构一览

```text
macOS Robot Debug Desk (Tauri / React / Three.js)
        │  SSH 隧道（本地端口 → Jetson 127.0.0.1:8765）
        ▼
Jetson / Ubuntu 22.04  ·  easy_debug_bridge (ROS 2 Humble)
        │  DDS / topics / controllers / package:// 资源
        ▼
micro-ROS Agent · STM32 · URDF / cameras / controllers …
```

Bridge 只监听 Jetson 的 `127.0.0.1:8765`，不应直接开放到局域网。本机连接 Profile 中的「ROS 环境脚本」必须指向机器人工作空间的 `install/setup.bash`；Bridge 会在该环境之后再 source 自己的安装空间，以便 `ament_index` 能解析 URDF 中的资源包。

## 功能概览

### 连接与会话

- Jetson SSH 连接配置持久化（主机、用户、端口、私钥、ROS Domain、ROS setup、Topic 等）
- 自动检查 SSH → micro-ROS Agent → 启动 Bridge → 本地端口转发 → WebSocket
- 首选本地端口被占用时自动选空闲端口；退出时回收 SSH 隧道子进程
- 每 5 秒检查 `micro-ros-agent-stm32h723.service`（运行 / 停止 / 检查失败）
- 断开或重连时清空上一会话的 Topic、URDF、JointState、控制器与硬件状态；保留连接配置与布局偏好

### Topics

- ROS graph Topic 名称与类型发现；只读订阅、JSON 查看、频率与消息计数
- Topic 搜索过滤；默认 30 秒自动刷新（可在设置中调整）
- Topic Graph（近似 `rqt_graph`）与 Topic Inspector（本机 jq 1.8.2 WASM 过滤）
- `sensor_msgs/msg/Image` Canvas 实时预览（二进制 WebSocket，避免 Base64 膨胀）
- `/controller_manager` Controller 列表（名称、类型、状态）及 Activate / Deactivate

第一版可解码的消息类型：

- `std_msgs/msg/String` · `Bool` · `Float32` · `Float64` · `Int32` · `UInt32` · `Float32MultiArray` · `Float64MultiArray`
- `sensor_msgs/msg/JointState` · `sensor_msgs/msg/Image`（预览路径）
- `microros_stm32h723_bridge/msg/JointCommand` · `HardwareStatus`

其他未注册类型仍会出现在 Topic 列表中，但内容查看会提示暂不支持。

### URDF / Robot View

- 从 `std_msgs/msg/String` Topic（默认 `/robot_description`）获取 URDF；晚加入订阅使用 `RELIABLE + TRANSIENT_LOCAL`
- Three.js + React Three Fiber + `urdf-loader` 渲染；`JointState` 驱动关节
- Jetson 侧解析并传输 `package://` STL / DAE / OBJ 与纹理（含 `--symlink-install` 链接，拒绝路径穿越）

### MIT 电机控制

控制面板发布到 `/stm32/joint_commands`（`microros_stm32h723_bridge/msg/JointCommand`）。当前 STM32 固件仅激活 joint1，其余关节字段由 Bridge 写零。

```text
0 HOLD     锁存当前反馈位置并使用 Kp/Kd 保持
1 TRACK    跟踪 position/velocity/kp/kd/effort
2 RETURN   跟踪返回目标
3 DISABLE  撤销电机使能
```

Bridge 与界面仅限制 Effort（`|effort| ≤ 1 Nm`）；Position / Velocity / Kp / Kd 不做上位机限幅。非 DISABLE 指令须完成界面安全解锁，并满足：command subscriber 存在、status / joint feedback 未过期、joint1 active。界面按 20 Hz 发送；停止后固件约 100 ms 进入 HOLD、500 ms 后 DISABLE。「停止并 DISABLE」无需解锁且始终可用。

### Joint4 标定

- 左侧 Calibration 页订阅 `/joint4_calibration_controller/status`
- 通过受限 `std_srvs/srv/Trigger` 执行 Begin / Capture / Release / Fit / Reset
- Capture 需 Controller active、状态新鲜、姿态稳定，并确认手部支撑已撤掉
- 采样与拟合结果可导出为本机 JSON / CSV 审计报告（详见 `docs/joint4-calibration.md`）

### TCP 拖拽轨迹

- 仅当存在 active 的 `JointTrajectoryController` 时开放 Robot View TCP 拖拽
- 拖拽过程做位置 IK；松手后下发 `trajectory_msgs/msg/JointTrajectory` 到控制器的 `~/joint_trajectory`
- Bridge 校验 Topic 白名单、关节名、点数、有限值与严格递增时间；IK 未收敛或缺新鲜 JointState 时拒发并显示原因

### rosbag / 诊断

- 工具栏「开始录制」经受约束的 Tauri SSH 命令在 Jetson 执行 `ros2 bag record -a`（输出到 `$HOME/robot-console-bags/…`）
- 「诊断快照」保存本机脱敏 JSON（连接信息、Topics、Controller、Agent、HardwareStatus 等；不含私钥路径）
- 「暂停显示」只冻结 WebView 消费，不断开 Bridge，也不停止后台 rosbag

## 本机开发

```bash
npm install
npm run tauri dev
```

### 安装到 macOS（`install:mac`）

```bash
npm run install:mac
```

会先构建 release 版 **Robot Console.app**，再原子安装到 `/Applications/Robot Console.app`；更新失败时恢复旧版本。仅需生成安装包时可运行 `npm run tauri build`。

调试版 `.app`：

```text
src-tauri/target/debug/bundle/macos/Robot Console.app
```

## Jetson Bridge（`deploy:bridge`）

Bridge 源码位于 `bridge/easy_debug_bridge`，依赖 ROS 2 Humble、Boost.Beast 和标准 ROS 消息包。

优先使用仓库脚本部署（比较 → 同步 → `colcon build` → 校验；可选备份与重启）：

```bash
npm run deploy:bridge -- --dry-run
npm run deploy:bridge -- --backup
npm run deploy:bridge -- --skip-sync --skip-build --restart
```

脚本默认 SSH host `damiao`、远端工作区 `/home/jialiang/easy_debug_bridge`（同步到 `src/easy_debug_bridge/`）、ROS overlay `/home/jialiang/Project/leader_follower/install/setup.bash`、端口 `8765`。默认不同步删除远端多余文件；需要清理时再加 `--delete`。详见 `scripts/deploy-bridge.mjs --help` 与 `AGENTS.md`。

首次手工初始化工作区（脚本也会 `mkdir -p` 远端 package 目录）仍可：

```bash
mkdir -p ~/easy_debug_bridge/src
# 推荐用 npm run deploy:bridge，而不是整目录 cp 覆盖
cd ~/easy_debug_bridge
source /opt/ros/humble/setup.bash
colcon build --symlink-install --packages-select easy_debug_bridge
```

## 当前 damiao 环境

Bridge 已部署并构建在：

```text
/home/jialiang/easy_debug_bridge
```

默认连接配置：

```text
SSH host: damiao
ROS setup: /home/jialiang/Project/leader_follower/install/setup.bash
Remote port: 8765
Local port: 18765
URDF topic: /robot_description
JointState topic: /stm32/joint_states
```

如果机器人使用其他 overlay（例如 URDF package 位于另一个工作空间），请把「ROS 环境脚本」改成对应 overlay 的 `install/setup.bash`。

## 验证

功能变更须先跑全量单元测试，再执行桌面端构建：

```bash
npm test
npm run build
```

`npm test` 依次运行：前端 Vitest、Tauri/Rust、Bridge 核心 C++、`test:install`、`test:deploy`。

Bridge 建立隧道后可运行：

```bash
node scripts/smoke-bridge.mjs 18765
```

- 基本功能与测试覆盖：[docs/basic-features.md](docs/basic-features.md)
- 协议说明：[docs/protocol.md](docs/protocol.md)
- 架构说明：[docs/architecture.md](docs/architecture.md)
- Joint4 标定：[docs/joint4-calibration.md](docs/joint4-calibration.md)
- 贡献 / Agent 规范：[AGENTS.md](AGENTS.md)
