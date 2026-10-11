# Joint4 多姿态标定操作指南

本页面用于采集 joint4 多个静态姿态并请求 `joint4_calibration_controller` 进行重力与 camera_link 等效负载回归。结果只显示和保存；Robot Console 不会修改 URDF、控制器 YAML 或在线参数。

## 前置条件

1. 机械臂由操作者可靠托住，物理急停随时可用，周围没有人员和障碍物。
2. Jetson 已按标定模式启动，`joint4_calibration_controller` 已加载并处于 `active`。
3. 普通 `gravity_compensation_controller` 不得与标定控制器同时激活，两者会竞争相同 effort command interfaces。
4. Robot Console 已连接 Jetson，Calibration 页面显示 `Controller active` 和 `status 10 Hz 正常`。

Robot Console 不负责自动激活控制器。请在 Dashboard 的 ROS Control 面板检查状态并显式操作。

## 单个姿态流程

1. 始终托住机械臂，将 joint4 缓慢移动到新姿态。界面要求 `|dq4| ≤ 0.05 rad/s` 才允许开始。
2. 勾选“我已托住机械臂”，点击 **Begin Pose**。控制器把当前位置设为参考角，并启用受限软保持。
3. 在保持建立后逐渐撤掉手部支撑。不要突然松手，也不要推拉关节；人为外力会直接污染回归数据。
4. 观察实时状态：
   - 软保持修正力矩必须保持在 `±1.5 N·m` 内；
   - q4 相对参考角位移必须小于 `0.12 rad`；
   - 标定过程速度必须小于 `0.20 rad/s`；
   - 采样稳定速度必须不高于 `0.01 rad/s`。
5. 确认手已撤离后勾选“当前没有人为外力”。连续稳定满 `1.5 s` 后 **Capture Pose** 才会启用。
6. Capture 成功后重新托住机械臂，再勾选托住确认并点击 **安全停止 · Release**。
7. 软保持释放后再移动到下一姿态。至少采 4 个姿态，推荐 6–8 个；姿态应覆盖明显不同的 joint4 重力矩和 camera_link 灵敏度。

## 拟合与保存

完成至少 4 个姿态并释放当前 pose 后点击 **执行 Fit**。页面展示：

- `gravity_scale`
- `constant_bias` 与 `gravity_rmse`
- `equivalent_payload_mass`
- `payload_bias` 与 `payload_rmse`

CSV 保存本次界面记录的逐姿态数据和拟合字段；JSON 额外包含导出时间、安全阈值、schema 版本和 `advisoryOnly: true`。若 Controller 已有历史样本但并非通过当前页面采集，页面仍可请求 Fit，但导出的逐姿态表只包含当前页面捕获到的数据。

## 异常与恢复

出现下列任一情况时，Robot Console 会禁止采样：Controller 非 active、状态超过 1.5 秒未更新、`safety_fault`、保护阈值触发、状态格式错误或 Trigger 服务失败。

恢复顺序：

1. 立即托住机械臂，不要继续移动或采样。
2. 在已托住确认后点击 **安全停止 · Release**，清除当前软保持姿态与 fault latch。
3. 检查 Jetson 网络、`controller_manager`、`/joint4_calibration_controller/status` 和五个 Trigger 服务。
4. 将 joint4 移回无干涉、安全且静止的姿态。
5. 界面恢复 `Controller active` 和新鲜状态后重新执行 Begin Pose。兼容旧版 Controller：如果 Release 后仍保持 `safety_fault`，姿态已释放且速度不高于 0.05 rad/s 时，托住确认后的 Begin Pose 可在当前位置重建参考并清除 latch；Capture 和 Fit 仍保持锁定。

若无法确认机械臂受力状态，不要依赖 GUI 恢复；使用物理急停并按现场安全流程处理。

## ROS 2 接口

固定服务：

- `/joint4_calibration_controller/begin_pose`
- `/joint4_calibration_controller/release_pose`
- `/joint4_calibration_controller/capture_pose`
- `/joint4_calibration_controller/fit`
- `/joint4_calibration_controller/reset`

服务类型均为 `std_srvs/srv/Trigger`。状态 Topic 为 `/joint4_calibration_controller/status`，类型为 `std_msgs/msg/Float64MultiArray`，顺序依次为 q4、dq4、URDF 重力矩、软保持修正力矩、所需总力矩、camera_link 单位质量灵敏度、姿态参考角、连续稳定秒数、样本数量、pose_active、safety_fault、pose_captured。
