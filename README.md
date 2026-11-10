# Rebotarm Debug Desk

macOS 上的 ROS 2 Humble 调试与受控操作控制台（Tauri + React + Three.js）。桌面端通过 **SSH 隧道** 连接 Jetson 上的 WebSocket Bridge；**Mac 不安装、不加入本地 ROS / DDS**。

| | |
|---|---|
| **产品名** | Rebotarm Debug Desk |
| **仓库** | [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk) |
| **npm 包名** | `rebotarm-debug-desk` |
| **应用显示名** | Tauri `productName` / 窗口标题 / `/Applications` 安装包仍为 **Robot Console**（`Robot Console.app`） |
| **用户文档** | [https://phamstered.github.io/rebotarm-debug-desk/](https://phamstered.github.io/rebotarm-debug-desk/)（GitHub Pages） |

> 本文档以 **Rebotarm Debug Desk** 作为用户面向产品名；npm 包名为 `rebotarm-debug-desk`；`.app` 显示名仍以代码侧 **Robot Console** 为准（文档不静默改 Tauri `productName`）。

Robot View 支持可选的桌面物体几何检测与同帧三维框显示。确认目标可点击生成俯抓候选；分段视觉 Pick 执行默认因未标定而禁用，可先完成预览及隔离测试。Jetson 安装 `libpcl-dev` 后重新构建 Bridge 即可启用检测；使用限制和 ROI 配置见 [基础功能](docs/basic-features.md#桌面物体三维框几何检测)。

## 相关仓库 / 职责

| 仓库 | 职责 | 文档 |
|---|---|---|
| [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk) | 上位机（本仓） | [Pages](https://phamstered.github.io/rebotarm-debug-desk/) |
| [`phamstered/rebotarm-ros2-stack`](https://github.com/phamstered/rebotarm-ros2-stack) | ROS 2 controller | [Pages](https://phamstered.github.io/rebotarm-ros2-stack/)（预期） |
| [`phamstered/rebotarm-executor`](https://github.com/phamstered/rebotarm-executor) | FreeRTOS + micro-ROS 固件 | [Pages](https://phamstered.github.io/rebotarm-executor/)（预期） |

后两仓若文档站点 404，需在对应仓库 **Settings → Pages → GitHub Actions** 启用（private 仓需 GitHub Pro）。

## 架构一览

| 层 | 组件 |
|---|---|
| **macOS** | Rebotarm Debug Desk（Tauri / React / Three.js）· Rust SSH 会话 |
| **隧道** | `ssh -N -L` 本地端口 → Jetson `127.0.0.1:8765`（认证 / 主机密钥 / 加密） |
| **Jetson** | `easy_debug_bridge`（C++ WebSocket · rclcpp）· **仅 loopback** |
| **ROS 2** | Humble graph · Topics / Controllers / `package://` · URDF |
| **固件** | micro-ROS Agent · STM32 · 电机（JointCommand / HardwareStatus） |

数据流概要：Topics / HardwareStatus / JointState **入站** → App；`joint_command` / `trajectory_command` **出站** → ROS（含 ACK）；断开时若电机命令流在运行，先请求 **DISABLE**。

安装版由 Rust 原生会话持有 Bridge WebSocket；WebView 通过有界二进制拉取接收预览，并通过独立请求通道取得 ACK。连接与消费者代次会阻止旧会话数据进入新连接。多窗口页面拆出仍在开发，当前界面尚未提供拆窗入口。

交互式分层图与标注数据流见用户文档 **[架构](https://phamstered.github.io/rebotarm-debug-desk/architecture)**（HTML 图，非 Mermaid）。源文件：[docs/architecture.md](docs/architecture.md)。

Bridge 只监听 Jetson 的 `127.0.0.1:8765`，不应直接开放到局域网。本机连接 Profile 中的「ROS 环境脚本」必须指向机器人工作空间的 `install/setup.bash`；Bridge 会在该环境之后再 source 自己的安装空间，以便 `ament_index` 能解析 URDF 中的资源包。

## 功能概览

已实现能力的模块说明（做什么 / 怎么用 / 注意与边界）与 HTML 流程图见用户文档：

**[功能概览（完整）](docs/features.md)** · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features)

| 模块 | 文档锚点 |
|---|---|
| 连接与会话 | [§1](docs/features.md#1-连接与会话) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_1-连接与会话) |
| Topics / Graph / Inspector | [§2](docs/features.md#2-topics--graph--inspector) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_2-topics-graph-inspector) |
| Monitor（多面板曲线 / bag 回放） | [Monitor](docs/features.md#monitor) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#monitor) |
| LeRobot 数据采集 | [数据采集](docs/features.md#数据采集-lerobot-v3) |
| Robot View（URDF） | [§3](docs/features.md#3-robot-viewurdf) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_3-robot-view-urdf) |
| MIT 电机控制 | [§4](docs/features.md#4-mit-电机控制) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_4-mit-电机控制) |
| TCP 拖拽轨迹 | [§5](docs/features.md#5-tcp-拖拽轨迹) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_5-tcp-拖拽轨迹) |
| Joint4 标定 | [§6](docs/features.md#6-joint4-标定) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_6-joint4-标定) |
| 重力辨识（Bridge/UI；stack #24 FULL_ARM；Jetson E2E pending） | [§8](docs/features.md#8-重力辨识) · [设计/实现说明](docs/gravity-identification.md) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/gravity-identification) |
| 工具栏：rosbag / 诊断 / 布局 | [§7](docs/features.md#7-工具栏rosbag--诊断--布局) · [Pages](https://phamstered.github.io/rebotarm-debug-desk/features#_7-工具栏-rosbag-诊断-布局) |

Navigation 的 **Motion** 位于 Topics 后，集中提供 Robot View、URDF 模型分析、姿态库、动作组和 Controller 操作；Topics 保留 Graph / Inspector 与 Controller 只读状态，整栈 Teleop / Trajectory / VLA 模式管理仍在 Status。Motion 使用紧凑工作栏、按需连接详情/工具、图标导航、可恢复的专注模式和默认收起的 Controllers/输出区；动作组提供资源 Tab、右键/`⋯` 编辑、可固定属性及预览/时间轴布局切换。未就绪时也可进入 Motion 查看原因，执行仍受反馈、控制器和安全确认门禁约束。运动进行中，各页显示任务阶段及本会话取消入口。

Controller 列表通过 Bridge 的常驻 ROS 客户端查询，与运动健康检查共用缓存；桌面每秒静默读取，手动刷新和切换前后等待新查询。正常轮询不触发刷新按钮忙碌动画，健康查询的快照年龄和后台进度折叠在“查询详情”中。失败保留标注年龄的最近成功列表供查看，过期数据不授权控制操作；该查询独立于 MoveIt 支持。

动作组用时间轴编排已保存位置的姿态快照、过渡时长和停留，支持独立保存、修改和删除。Jetson Bridge 先准备到首姿态，再逐段 MoveIt 规划执行与实际停稳确认，支持段间暂停和整组取消；桌面端不使用定时器派发下一段。名义时间轴不包含准备、规划及停稳的额外耗时。详见 [基本功能](docs/basic-features.md#motion-动作组)。

Motion 的 Robot View 在同一连接内保留已加载场景和 128 MiB 资源缓存，隐藏时暂停渲染并取消未完成加载；资源使用二进制传输（兼容旧 Base64）。图像仅发送给订阅它的连接，Inspector 隐藏时释放图像订阅。RGBD 仅在 Motion → Robot View、窗口可见且实时显示开启时订阅；切到姿态库或其他页即释放当前客户端兴趣。断开重连后重新获取资源，详见 [架构](docs/architecture.md#urdf-assets)。

行为细节与单元测试矩阵见 [docs/basic-features.md](docs/basic-features.md)；连接补充见 [docs/connect.md](docs/connect.md)。

Robot View 的 TCP 操作区底部可保存当前实测姿态，姿态库页支持编辑、删除及点击执行：Status 的 Trajectory 一键启动会在真实轨迹控制器与重力补偿自检通过后启动 MoveIt。会话安全解锁后，MoveIt2 规划并执行到保存的六关节位置和可选夹爪（joint7）目标；HOME 从当前 SRDF 同步并保持夹爪当前开度，支持取消、停稳确认和实际位置误差诊断。Robot View 的关节调整与 TCP 预览也通过同一运动入口执行；TCP 保留青色球自由拖拽快速定位，使用 XYZ 平移箭头与 RPY 旋转圆环（支持基座/工具坐标）或输入 mm/度微调；松手保留位姿预览，点击确认后以完整 Pose 目标交给 MoveIt 执行。夹爪需要配套控制栈的独立轨迹控制器和标定配置。详见 [已实现功能](docs/basic-features.md)；[设计文档](docs/positions-moveit-design.md) 中的独立窗口等内容仍为后续方案。

Status 与 Robot View 显示 STM32 相对 Jetson 的时间同步状态；Bridge 校验源时间戳和新版固件同步诊断，失步期间阻止 MoveIt 执行，时间基准改变后重建 RGBD 的 TF 历史。时钟偏差由 Jetson 测量，不依赖 Mac 校时；固件周期同步和控制栈时间过滤需要配套部署。

运动不连贯或低速抖动时，可使用 [只读运动监控脚本](docs/motion-diagnostics.md) 在 Jetson 记录规划轨迹、JTC 参考/实际反馈与 STM32 指令，并离线分析；不改变控制器或电机状态。

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

连接页“升级 Bridge”需要本机已安装 Node.js 和本仓库源码。从 Finder/Dock 启动时不依赖终端的 PATH：依次查找 `NODE_BINARY`、应用 PATH、macOS 的 `/opt/homebrew/bin/node` 与 `/usr/local/bin/node`；进度中显示实际路径。显式 `NODE_BINARY` 无效时直接报错，不静默换版本。仅通过 shell 初始化的版本管理器可在启动应用时提供 `NODE_BINARY` 绝对路径；应用不会执行 shell 启动文件。

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

脚本默认连接 SSH host `jetson`（通用别名，`--host` / `$BRIDGE_DEPLOY_HOST`），远端工作区 `easy_debug_bridge`（相对远端用户 `$HOME`，即 `$HOME/easy_debug_bridge`，同步到 `src/easy_debug_bridge/`；`--remote` / `$BRIDGE_DEPLOY_REMOTE`，可为绝对路径或相对 `$HOME` 的路径），ROS overlay `Project/rebotarm-ros2-stack/install/setup.bash`（同样相对 `$HOME`；`--ros-setup` / `$BRIDGE_DEPLOY_ROS_SETUP`），端口 `8765`（`--port` / `$BRIDGE_DEPLOY_PORT`）。本地 package 路径相对仓库根目录解析（由脚本位置推导）。远端路径只允许 `[A-Za-z0-9._-/]`，拒绝 `~`、`.`/`..`、空段和以 `-` 开头的段。默认不同步删除远端多余文件；需要清理时再加 `--delete`。详见 `scripts/deploy-bridge.mjs --help` 与 `AGENTS.md`。

首次手工初始化工作区（脚本也会 `mkdir -p` 远端 package 目录）仍可：

```bash
mkdir -p ~/easy_debug_bridge/src
# 推荐用 npm run deploy:bridge，而不是整目录 cp 覆盖
cd ~/easy_debug_bridge
source /opt/ros/humble/setup.bash
colcon build --symlink-install --packages-select easy_debug_bridge
```

## 示例机器人环境

Bridge 部署并构建在 Jetson 工作区（示例）：

```text
~/easy_debug_bridge   # 默认 easy_debug_bridge，相对远端 $HOME
```

连接配置示例（主表单填 SSH；「高级」可改 Domain / setup；Topic 为内置默认）：

```text
SSH host: jetson                                  # 默认通用别名，按需修改
ROS setup: Project/rebotarm-ros2-stack/install/setup.bash    # 「高级」；相对远端 $HOME；也可填绝对路径
Remote port: 8765
Local port: 18765
URDF topic: /robot_description                    # 内置默认，界面不编辑
JointState topic: /stm32/joint_states             # 内置默认，界面不编辑
```

如果机器人使用其他 overlay（例如 URDF package 位于另一个工作空间），请在「高级」里把「ROS 环境脚本」改成对应 overlay 的 `install/setup.bash`。

左臂腕部 RGBD 点云默认订阅 `/cameras/left_arm/wrist/`；一键 RealSense 依赖 ROS 栈中已安装的 `rebotarm_gazebo/left_wrist_camera.launch.py`，由它启用深度对齐、帧同步和连接到机器人模型的相机 TF。更换相机或多相机部署时可在连接配置中修改 RGBD Topic。 RGBD 预览使用独立 ROS Context / DDS participant、接收 executor 与每会话处理线程，按采集时刻等待 TF 并丢弃过期帧；桌面以订阅令牌隔离旧流，停流后最长 500 ms 隐藏旧点云。

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

- 用户文档站点：[https://phamstered.github.io/rebotarm-debug-desk/](https://phamstered.github.io/rebotarm-debug-desk/)
- 基本功能与测试覆盖：[docs/basic-features.md](docs/basic-features.md)
- TODO / 待办列表：[docs/todo.md](docs/todo.md)
- 协议说明：[docs/protocol.md](docs/protocol.md)
- 架构说明：[docs/architecture.md](docs/architecture.md)
- Joint4 标定：[docs/joint4-calibration.md](docs/joint4-calibration.md)
- 贡献 / Agent 规范：[AGENTS.md](AGENTS.md)

### Teleop 的 Graph / DDS 故障

Topic Graph 的「显示调试 Bridge」只控制本控制台节点，不会隐藏 STM32 或相机节点。Bridge 与一键 arm 启动使用进程级 Fast DDS UDP profile，避免损坏的 SHM 锁影响 ROS 发现；显式 DDS XML 环境变量可覆盖，详见 [架构](docs/architecture.md#console-managed-ros-transport)。升级此修复需要更新桌面、部署 Bridge，并更新/构建控制栈的 `joint_state_relay`；不需要改写外部 Star Arm 驱动。

Bridge 部署构建对所选包使用 `--cmake-clean-first`，避免 rsync 保留的源文件时间早于旧远端对象时漏编；不清理其他包。重启 Topic 可用 `--joint-state-topic` / `--command-topic` / `--status-topic` 配置，应用内升级自动使用连接 Profile 的值。


Status 控制模式支持「拖动示教」：六轴重力补偿/阻尼下手动拖动，夹爪可用手拨动，可保存姿态后切回 Trajectory 回放。需要配套 ROS 栈 `--mode=teaching` 支持；进入与退出需现场支撑确认，退出不会主动回零。见 [拖动示教说明](docs/basic-features.md#拖动示教六轴柔顺-手动夹爪)。

### 手眼标定

Navigation → **手眼标定**：Target / Context / Calibrate 对应 RViz 操作习惯，支持手动停稳采样、Mac 本地 OpenCV 求解、独立姿态复验及完整样本/外参导出；不依赖 RViz、MoveGroup 或深度图。详见 [已实现功能](docs/basic-features.md#上位机手眼标定)。

构建手眼计算模块需 OpenCV、pkg-config 与 nlohmann-json 开发头文件，macOS 可用 `brew install opencv pkg-config nlohmann-json`。`npm run prepare:handeye` 会生成并打包本地计算模块，`npm run tauri build` 自动执行该步骤；已安装应用无需这些开发工具。`npm run test:handeye` 覆盖检测、坐标变换方向、五种求解器、独立复验及采样时间/停稳边界，并纳入 `npm test`。
