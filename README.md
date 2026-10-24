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

Robot View 在同一连接内保留已加载场景和 128 MiB 资源缓存，隐藏时暂停渲染并取消未完成加载；资源使用二进制传输（兼容旧 Base64）。图像仅发送给订阅它的连接，Inspector 隐藏时释放图像订阅。断开重连后重新获取资源，详见 [架构](docs/architecture.md#urdf-assets)。

行为细节与单元测试矩阵见 [docs/basic-features.md](docs/basic-features.md)；连接补充见 [docs/connect.md](docs/connect.md)。

待审核设计：[位置管理 Panel、固定 HOME 与 MoveIt2 规划方案（Draft）](docs/positions-moveit-design.md)。该方案尚未实现，当前轨迹行为以已实现功能文档为准。

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
- 协议说明：[docs/protocol.md](docs/protocol.md)
- 架构说明：[docs/architecture.md](docs/architecture.md)
- Joint4 标定：[docs/joint4-calibration.md](docs/joint4-calibration.md)
- 贡献 / Agent 规范：[AGENTS.md](AGENTS.md)

### Teleop 的 Graph / DDS 故障

Topic Graph 的「显示调试 Bridge」只控制本控制台节点，不会隐藏 STM32 或相机节点。Bridge 与一键 arm 启动使用进程级 Fast DDS UDP profile，避免损坏的 SHM 锁影响 ROS 发现；显式 DDS XML 环境变量可覆盖，详见 [架构](docs/architecture.md#console-managed-ros-transport)。升级此修复需要更新桌面、部署 Bridge，并更新/构建控制栈的 `joint_state_relay`；不需要改写外部 Star Arm 驱动。
