# Robot Console

基于 Tauri、Rust、React 和 Three.js 的 ROS 2 Humble 调试与受控操作上位机。桌面端运行在 macOS，ROS Bridge 运行在 Jetson/Ubuntu 22.04；两端仅通过 SSH 隧道通信，Mac 不需要安装 ROS 2。

## 已实现

- Jetson SSH 连接配置与持久化
- 自动检查 SSH、启动 Bridge、建立本地端口转发
- 首选本地端口被占用时自动选择空闲端口，应用退出时回收 SSH隧道子进程
- 每 5 秒检查 `micro-ros-agent-stm32h723.service`，显示运行、停止或检查失败状态
- ROS graph Topic 名称与类型发现
- 每 5 秒监测 `/controller_manager` 已加载 Controller 的名称、类型和状态
- 标准 Topic 只读订阅、JSON 查看、频率和消息计数
- 从 `std_msgs/msg/String` Topic 获取 URDF
- Three.js URDF 渲染和 `sensor_msgs/msg/JointState` 关节驱动
- Jetson 侧解析并传输 `package://` STL、DAE、OBJ和纹理
- 基于发布者端点选择兼容的 Reliability/Durability QoS
- `/stm32/joint_commands` MIT 控制面板，支持 HOLD、TRACK、RETURN、DISABLE
- 20 Hz命令流、序列号同步、反馈/订阅者预检和 Effort 限幅

第一版支持的消息内容类型：

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

其他未注册类型仍会出现在 Topic 列表中，但内容查看会提示暂不支持。

## MIT 电机控制

控制面板使用 `microros_stm32h723_bridge/msg/JointCommand`。当前 STM32 固件仅激活 joint1，其余六个关节字段始终由 Bridge 写零。

```text
0 HOLD     锁存当前反馈位置并使用 Kp/Kd 保持
1 TRACK    跟踪 position/velocity/kp/kd/effort
2 RETURN   跟踪返回目标
3 DISABLE  撤销电机使能
```

Bridge 和界面仅限制 Effort；Position、Velocity、Kp、Kd 不做上位机限幅：

```text
|effort| <= 1 Nm
```

非 DISABLE 指令必须完成界面安全解锁，并满足：STM32 command subscriber 存在、status和joint feedback未过期、joint1 active。`fault_code` 仍在界面显示，但不阻止命令发布，最终执行安全由 STM32 固件负责。界面按 20 Hz发送；停止发送后，固件会在 100 ms进入 HOLD，并在 500 ms后 DISABLE。“停止并 DISABLE”无需解锁且始终可用。

## 本机开发

```bash
npm install
npm run tauri dev
```

生产构建：

```bash
npm run build
npm run tauri build
```

调试版 `.app` 位于：

```text
src-tauri/target/debug/bundle/macos/Robot Console.app
```

## Jetson Bridge

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

本机连接 Profile 中的“ROS 环境脚本”必须指向机器人工作空间的 `install/setup.bash`。Bridge 会在该环境之后 source 自己的安装空间，以便 `ament_index` 能解析 URDF 中的资源包。

Bridge 只监听 Jetson 的 `127.0.0.1:8765`，不应直接开放到局域网。

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

如果机器人使用其他 overlay（例如 URDF package 位于另一个工作空间），请把“ROS 环境脚本”改成对应 overlay 的 `install/setup.bash`。

## 验证

所有功能变更必须先运行全量单元测试，再执行桌面端构建：

```bash
npm test
npm run build
```

Bridge 建立隧道后，可运行：

```bash
node scripts/smoke-bridge.mjs 18765
```

基本功能与测试覆盖见 [docs/basic-features.md](docs/basic-features.md)，协议说明见 [docs/protocol.md](docs/protocol.md)，架构说明见 [docs/architecture.md](docs/architecture.md)。
