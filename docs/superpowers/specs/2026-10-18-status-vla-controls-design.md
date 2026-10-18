# Status VLA 启停与 Monitor Chunk（Scheme B）

日期：2026-10-18  
仓库：`phamstered/rebotarm-debug-desk`  
对齐：`rebotarm-ros2-stack` PR #15 / `docs/vla-integration.md`

## 行为摘要

- **控制器**：`vla_position_controller`（plugin `VlaPositionController`，position only，joint1–6）
- **Topic**：`/vla/joint_chunk`
- **消息**：`microros_stm32h723_bridge/msg/VlaJointChunk` — `Header`、`float32[] positions`、`float32 timeout_sec`
- **并行**：保持 `gravity_compensation_controller`（effort）active
- **互斥**：`arm_teleop_controller` / `arm_trajectory_controller`（同 position 接口）
- **Desk 路径**：Status 一键启停 → SSH `ros2 control switch_controllers`（`switch_ros_controllers` 批量）；**不**直写 `/stm32/joint_commands`
- **启动**：HOLD → `start_arm_mode stop`（停 Teleop/Trajectory 进程组）→ activate `vla_position_controller`（+ 未激活的 gravity）并 deactivate 互斥控制器
- **停止**：HOLD → deactivate `vla_position_controller`；一键「停止」同时停 Teleop/Trajectory 进程
- **Status 卡片**：tone 来自 controller active；可选 chunk Hz（Bridge 成功订阅时）
- **Monitor**：`+VLA` 模板仪表盘订阅 `positions[0..5]`
- **Mock（stack）**：`ros2 run microros_stm32h723_bridge mock_vla_chunk_publisher.py`

## 非目标

- Desk 内跑 VLA 模型
- 实现 `VlaPositionController`（stack）
- 固件 / MCU 协议变更
- E2E CI（paused）

## Bridge 依赖

Chunk Hz 与 Monitor 采样需要 Bridge 能订阅 `VlaJointChunk`（运行时字段解码或内置）。若类型尚未进入 Bridge 安装环境，订阅可能失败；Status 仍可按 controller 状态工作，Monitor 字段在类型可用后即可显示。
