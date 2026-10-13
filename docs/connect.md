# 连接与 Bridge

桌面端不直接加入 DDS。连接链路是：

```text
SSH 检查 → micro-ROS Agent 状态 → 启动 Bridge（若未监听）→ ssh -N -L 本地转发 → WebSocket
```

## 连接配置（Profile）

可持久化的字段包括：SSH 主机 / 用户 / 端口 / 私钥、ROS Domain、ROS 环境脚本（`install/setup.bash`）、以及各 ROS Topic（如 URDF、JointState）。

- 连接后可从全局工具栏重新打开连接配置；**保存不会中断当前会话**，新值在下次重连时生效。
- 旧配置会自动迁移（例如旧 ROS setup 路径、旧 `/joint_states` → 当前默认 `/stm32/joint_states`）。
- 首选本地端口被占用时自动选择空闲端口，并在界面显示实际转发端口。
- 断开时关闭 WebSocket 与 SSH 隧道；若电机命令流在运行，先请求 DISABLE。
- 断开 / 重连会清空上一会话的 Topic、采样、URDF、JointState、控制器与硬件状态、错误与未完成请求；**保留**连接配置与布局偏好。

## Bridge 监听边界

- Bridge 只监听 Jetson 的 `127.0.0.1:8765`，不应直接开放到局域网。
- 「ROS 环境脚本」必须指向机器人工作空间的 `install/setup.bash`，可为绝对路径或相对远端用户 `$HOME` 的路径（SSH 命令在 `$HOME` 下执行）；只允许 `[A-Za-z0-9._-/]`，拒绝 `~`、`.`/`..`、空段和以 `-` 开头的段。Bridge 会在该环境之后再 source 自己的安装空间，以便 `ament_index` 解析 URDF 中的 `package://` 资源。

## micro-ROS Agent

连接后每 5 秒检查 `micro-ros-agent-stm32h723.service`，界面区分运行中、未运行与检查失败，并展示 loaded/active/substate、PID、开机启用状态等。

## Profile 示例

```text
SSH host: jetson                                  # 默认通用别名，按需修改
ROS setup: leader_follower/install/setup.bash    # 默认，相对远端 $HOME；也可填绝对路径
Remote port: 8765
Local port: 18765
URDF topic: /robot_description
JointState topic: /stm32/joint_states
```

若机器人使用其他 overlay（例如 URDF package 在另一工作空间），请把「ROS 环境脚本」改成对应 overlay 的 `install/setup.bash`。

## 会话建立后的验证

隧道建立后可对本机转发端口做冒烟检查：

```bash
node scripts/smoke-bridge.mjs 18765
```

更完整的协议字段见 [Bridge 协议](./protocol)。部署 / 更新 Jetson 上的 Bridge 包请用 [deploy:bridge](./deploy-bridge)，不要把「已编译」当成「当前进程已更新」。
