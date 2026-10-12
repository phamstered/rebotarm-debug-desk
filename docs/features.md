# 功能概览

以下仅汇总**已实现**能力。行为细节、边界与单元测试矩阵见 [基本功能与测试覆盖](./basic-features)。

## 连接与会话

- Jetson SSH 配置持久化与自动迁移
- SSH → Agent → Bridge → 本地端口转发 → WebSocket 的分阶段连接与错误展示
- 端口占用时自动回退；退出时回收隧道子进程
- 重连清理会话数据，保留配置与布局

## Topics · Graph · Inspector · Control

- Topic 名称/类型发现，只读订阅，JSON、频率与计数
- Topic 搜索；默认约 30 秒自动刷新（设置可调）
- Topic Graph（近似 `rqt_graph`）与 Topic Inspector（本机 jq 1.8.2 WASM）
- `sensor_msgs/msg/Image` Canvas 预览（二进制 WebSocket 路径）
- `/controller_manager` 列表与 Activate / Deactivate（经受约束的 SSH `ros2 control`）

可解码消息类型（未注册类型仍可在列表中出现，但内容查看会提示暂不支持）：

- `std_msgs/msg/String` · `Bool` · `Float32` · `Float64` · `Int32` · `UInt32` · `Float32MultiArray` · `Float64MultiArray`
- `sensor_msgs/msg/JointState` · `sensor_msgs/msg/Image`（预览路径）
- `microros_stm32h723_bridge/msg/JointCommand` · `HardwareStatus`

## URDF / Robot View

- 从配置的 `std_msgs/msg/String` Topic（默认 `/robot_description`）取 URDF；晚加入订阅使用 `RELIABLE + TRANSIENT_LOCAL`
- Three.js + R3F + `urdf-loader`；`JointState` 驱动关节
- Bridge 解析并传输 `package://` STL / DAE / OBJ 与纹理（兼容 `--symlink-install`，拒绝路径穿越）

## MIT 电机控制

发布到 `/stm32/joint_commands`（`JointCommand`）。当前固件仅激活 joint1，其余关节字段由 Bridge 写零。

| mode | 含义 |
|---|---|
| 0 HOLD | 锁存反馈位置并用 Kp/Kd 保持 |
| 1 TRACK | 跟踪 position / velocity / kp / kd / effort |
| 2 RETURN | 跟踪返回目标 |
| 3 DISABLE | 撤销使能 |

Effort 限幅 `|effort| ≤ 1 Nm`；Position / Velocity / Kp / Kd 不做上位机限幅。非 DISABLE 须安全解锁，并满足 subscriber / 反馈新鲜度 / joint1 active。界面 20 Hz 发送；「停止并 DISABLE」始终可用。

## Joint4 标定

- Calibration 页订阅 `/joint4_calibration_controller/status`
- 经白名单 `Trigger` 服务：Begin / Capture / Release / Fit / Reset
- 可导出 JSON / CSV 审计报告（操作细则见 [Joint4 标定](./joint4-calibration)）

## TCP 拖拽轨迹

- 仅当存在 active 的 `JointTrajectoryController` 时开放
- 拖拽做位置 IK；松手下发 `trajectory_msgs/msg/JointTrajectory` 到 `~/joint_trajectory`
- Bridge 校验 Topic 白名单、关节名、点数、有限值与严格递增时间

## rosbag / 诊断 / 布局

- 「开始录制」：受约束 SSH 在 Jetson 执行 `ros2 bag record -a`
- 「诊断快照」：本机脱敏 JSON（不含私钥路径）
- 「暂停显示」只冻结 WebView 消费，不断开 Bridge、不停后台 rosbag
- 可调整侧栏与面板高度，布局持久化；「重置布局」恢复默认

## 明确不在当前切片内

见 [架构 · Current limits](./architecture#current-limits)：例如时间序列 Topic 图表、TF 可视化、rosbag 本地下载/索引/回放等仍属后续工作。
