# 连接与 Bridge

桌面端不直接加入 DDS。连接链路是：

```text
SSH 检查 → micro-ROS Agent 状态 → 启动 Bridge（若未监听）→ ssh -N -L 本地转发 → WebSocket
```

## 连接配置（Profile）

首页连接卡与工具栏「连接配置」主表单只编辑 **SSH** 字段：主机、用户名、端口、私钥路径。`ROS_DOMAIN_ID` 与 ROS 环境脚本收在默认折叠的「高级」里。URDF / JointState / Command / Status Topic 与 TCP Link 使用内置默认值（与 ros2-stack / 固件约定一致），界面不再编辑；旧 localStorage 里若仍有这些字段会继续读入，新保存仍会写出默认键以便后端 invoke 不变。

- 首页展示连接步骤（检查 SSH → 建立会话 → 连接 Bridge → 确认 Agent）与四段状态灯（SSH / Bridge / Agent / HardwareStatus）；失败时给出可读中文说明并支持「复制错误」/ Esc 关闭；Enter 可在 SSH 表单上触发连接。失败可「重试」（自检查 SSH 起全量重连，非整步断点续传）。
- 首页一行「上次连接」摘要（耗时或失败步骤/原因，`localStorage`）。成功 SSH 的主机写入最近主机列表，可一键回填；不改动 Profile 迁移逻辑。
- `ROS_DOMAIN_ID` 与默认值或上次成功值不一致时，状态条给出轻量域名不匹配提示（多机同网常见坑）。
- **默认**连接成功后进入只读 **Status** 页（设置中可关「连接成功后打开 Status」）。SSH 大表单不再占据已连接界面，改为顶部工具条紧凑「切换主机」（断开回首页）与「连接配置」。
- 已连接工具条保留压缩状态灯、Bridge 版本徽章（本地 vs 远端 build id；不匹配点击走既有升级提示，不自动全屏部署）、以及 `fault_code !== 0` 时可点击 Fault 芯片跳转 Status · Hardware 卡片并高亮。
- 默认 JointState Topic（`/stm32/joint_states`）收到数据后标记「ROS 就绪」；在此之前 **Monitor / Motor** 导航禁用并提示原因。不新增固件 Topic。
- Status 页汇总隧道/Bridge/Agent/Hardware/ROS 就绪/ros2_control/Domain 等卡片（详见 [功能概览 · Status](./features#status只读总览)）。
- 连接后可从顶部工具条重新打开连接配置；**保存不会中断当前会话**，新值在下次重连时生效。
- 旧配置会自动迁移（例如旧 ROS setup 路径、旧 `/joint_states` → 当前默认 `/stm32/joint_states`）。
- 首选本地端口被占用时自动选择空闲端口，并在界面显示实际转发端口。
- 断开时关闭 WebSocket 与 SSH 隧道；若电机命令流在运行，先请求 DISABLE。断开按钮保持醒目；本 PR 不含自动重连 / Demo 模式。
- 断开 / 重连会清空上一会话的 Topic、采样、URDF、JointState、控制器与硬件状态、错误与未完成请求；**保留**连接配置、最近主机与布局偏好。

## Bridge 监听边界

- Bridge 只监听 Jetson 的 `127.0.0.1:8765`，不应直接开放到局域网。
- 「ROS 环境脚本」（高级）必须指向机器人工作空间的 `install/setup.bash`，可为绝对路径或相对远端用户 `$HOME` 的路径（SSH 命令在 `$HOME` 下执行）；只允许 `[A-Za-z0-9._-/]`，拒绝 `~`、`.`/`..`、空段和以 `-` 开头的段。Bridge 会在该环境之后再 source 自己的安装空间，以便 `ament_index` 解析 URDF 中的 `package://` 资源。

## micro-ROS Agent

连接后每 5 秒检查 `micro-ros-agent-stm32h723.service`，界面区分运行中、未运行与检查失败，并展示 loaded/active/substate、PID、开机启用状态等。

## Profile 示例

```text
SSH host: jetson                                  # 主表单；默认通用别名
SSH user / port / identity                        # 主表单
ROS_DOMAIN_ID: 0                                  # 「高级」
ROS setup: leader_follower/install/setup.bash    # 「高级」；相对远端 $HOME 或绝对路径
# 以下为内置默认，界面不编辑：
Remote port: 8765
Local port: 18765
URDF topic: /robot_description
JointState topic: /stm32/joint_states
```

若机器人使用其他 overlay（例如 URDF package 在另一工作空间），请在「高级」里把「ROS 环境脚本」改成对应 overlay 的 `install/setup.bash`。

## Bridge 版本检查与升级

连接成功并收到 `hello` 后，桌面端会比较远端 `bridge_version` + `bridge_build_id` 与本机随应用发布的期望值（`src/bridgeVersion.ts`，与 Bridge 包同源生成）。

- **一致**：无提示，继续进工作区。
- **不一致**：弹出对话框展示本地期望 vs 远端当前，可选 **升级** / **跳过**。升级调用 Tauri `deploy_bridge`，内部执行仓库已有的 `scripts/deploy-bridge.mjs`（rsync + colcon + `--restart`），使用当前 SSH Profile（host / 端口 / 私钥 / ROS setup / domain / Bridge 端口）。进度显示在连接页状态区。**不会**烧录 STM32，也**不会**同步 ros2-stack 工作区。
- **缺少 build id**：工具栏提示「无法确认版本」，不强制升级。

期望 build id 变更时在仓库根执行 `npm run generate:bridge-build-id` 并提交生成文件。

## 会话建立后的验证

隧道建立后可对本机转发端口做冒烟检查：

```bash
node scripts/smoke-bridge.mjs 18765
```

更完整的协议字段见 [Bridge 协议](./protocol)。部署 / 更新 Jetson 上的 Bridge 包请用 [deploy:bridge](./deploy-bridge)，不要把「已编译」当成「当前进程已更新」。
