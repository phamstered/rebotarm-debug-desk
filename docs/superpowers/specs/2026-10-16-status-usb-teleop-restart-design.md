# Status USB / Teleop / Trajectory 一键拉起

日期：2026-10-16  
仓库：`phamstered/rebotarm-debug-desk`  
范围：Status 页增强（详情/失败原因/动作）+ SSH 一键 Teleop/Trajectory/RealSense；不刷写固件、不改 MCU 协议、不把 RealSense launch 写入 ros2-stack。

## 行为摘要

- **USB**：`probe_jetson_usb` SSH 跑 `lsusb` + by-id/ttyACM；MCU 指纹 `0483:5740`；RealSense `8086:*`。卡片仅「刷新检测」。
- **Agent**：既有 `check_micro_ros_agent`；新增 `restart_micro_ros_agent` → `systemctl restart micro-ros-agent-stm32h723.service`（失败带 journal/status 尾）。
- **Teleop / Trajectory / RealSense**：`probe_arm_mode` / `start_arm_mode`；工作区 `${LEADER_FOLLOWER_WS:-$HOME/Project/rebotarm-ros2-stack}`；Teleop=`scripts/start_arm_teleop.sh --position-controller=teleop`；Trajectory=同脚本 `trajectory` 或 `rebotarm_moveit_config move_group.launch.py`；RealSense=`realsense2_camera rs_launch.py`。启动前停旧进程组（SIGINT），模式切换前 Bridge `joint_command` HOLD。
- **门控**：Teleop/Trajectory 需 SSH + JointState ROS-ready；Agent 重启与 USB 刷新仅需 SSH。

## 非目标

- 统一 StartTeleop/StartTrajectory ROS service
- 固件 flash / executor 改动
- RealSense launch 并入 ros2-stack
