# 点位运动抖动采集与分析

`scripts/motion_diagnostics/monitor_motion.py` 是 Jetson 上独立运行的只读工具，不依赖桌面端或 Bridge 更新。仅订阅遥测、读取参数和已完成 MoveGroup 结果；不发送运动/取消指令、不切换 Controller、不修改控制参数。停止脚本不等于停止机械臂。

## 开始采集

在 Jetson 的终端运行，先加载 ROS 与机器人自定义消息：

```bash
~/robot-console-tools/record-motion.sh --duration 300
```

工具安装：将本仓 `scripts/motion_diagnostics/` 下的 `monitor_motion.py` 与 `record-motion.sh` 复制到 Jetson `~/robot-console-tools/`，并为 shell 脚本加执行权限。启动入口自动加载 `/opt/ros/humble/setup.bash` 与 `$HOME/Project/rebotarm-ros2-stack/install/setup.bash`。也可自行 source 环境后运行 `python3 monitor_motion.py record`，无额外 pip 包。不覆盖 Bridge package，不需要重编译/重启控制栈。

1. 终端打印 `OUTPUT=...`，默认为 `~/motion-captures/日期时间-随机后缀/`。
2. 等待每 5 秒的进度行中 `command`、`joint`、`hardware`、`controller` 均有数据后，再在桌面端按既有安全流程执行点位运动。
3. 先留约 5 秒静止数据，再逐个执行需要比较的点位；每次完成后停留约 3 秒。全部执行后再保留约 5 秒数据。
4. 按 **Ctrl+C** 停止采集，或等待默认 300 秒自动结束。SIGTERM 也会完成落盘及报告；SIGKILL/断电仅保留已落盘数据。
5. 保留整个输出目录，通知分析人员路径；只有 summary 不能做精确时间轴对齐。脚本不会自动上传数据。

可选参数：`--duration 600`（最大 3600 秒）、`--max-mb 256`（1–1024 MiB）、`--output ~/motion-captures/my-test`。输出目录必须不存在，避免覆盖之前的实验。达到原始文件大小上限、写入队列拥塞或磁盘错误时停止采集并标记结果不完整，不影响机器人控制。

默认使用当前终端的 `ROS_DOMAIN_ID`（未设置为 0），应与实际控制栈一致。Topic 以当前左臂控制栈固定地址采集；摄像头数据不订阅。

## 输出

| 文件 | 内容 |
|---|---|
| `metadata.json` | 开始 UTC/ROS/单调时钟、Domain、脚本哈希、Topic、结束原因、队列丢样与写入错误 |
| `events.jsonl` | 单调接收时间（相对开始秒数）、发布者 GID（旧版 rclpy 无逐帧 GID 时标记 unavailable）、完整消息；消息自带源时间戳单独保留；非有限传感器数值编码为 null |
| `summary.json` | 按发布者的接收/源时间间隔、sequence 跳号、每关节跟踪误差、目标/实际速度、硬件模式/故障、增益、各次运动窗口与轨迹点/速度/加速度统计 |
| `summary.md` | 可直接阅读的运动及轨迹摘要、观测与数据限制 |

采集 `/stm32/joint_commands`、`/stm32/joint_states`、`/stm32/status`、`/arm_trajectory_controller/controller_state`、`/display_planned_path`、MoveGroup/JTC action status 和 MoveGroup feedback。`/rosout` 仅保留与运动/硬件/控制器相关的 WARN 及以上日志。每 5 秒保存发布端节点/GID/QoS；参数只读一次，未就绪服务会重试。当前 MoveGroup 的限速与 adapter、JTC 的接口/插值、ControllerManager 的更新率也记录在原始事件中。

高速订阅使用 BEST_EFFORT + VOLATILE，兼容 MCU BEST_EFFORT 与 JTC RELIABLE 发布；action status 使用 RELIABLE + TRANSIENT_LOCAL。对采集开始后的已完成 Goal，只调用只读 `get_result` 获取缓存轨迹，结果不可用时保留缺失，不重发运动。开始前的历史 Goal 不计入新运动。

## 离线分析与传回

Mac 无需 ROS，只需 Python 3：

```bash
scp -r damiao:motion-captures/具体目录 ~/Downloads/
python3 scripts/motion_diagnostics/monitor_motion.py analyze ~/Downloads/具体目录
```

在 Jetson 也可以使用同一脚本的 `analyze` 子命令重新生成报告。分析会更新该目录内的 `summary.json` 和 `summary.md`，不修改原始数据。

## 如何解释

- 轨迹点数多不代表逐点停车：检查速度字段、内部全关节零速点及 JTC 实际参考曲线。
- 运动窗口依据采集期间观察到的 MoveGroup action status，包含规划到执行完成。采集中途开始的历史动作不会伪装成完整运动。停止采集时尚未结束的窗口标为不完整。
- 只有窗口中既有非零 JTC 参考速度又有底层指令时，才提示“采到的 STM32 目标速度全部为零”；这是窗口级候选原因，仍需分析人员按原始事件对齐。
- 接收时间间隔包含 DDS 与采集器调度，不等于 ros2_control 实际周期；sequence 缺口也可能来自接收侧 BEST_EFFORT 丢包。支持逐帧 GID 时按发布者分开统计；旧版 Humble rclpy 不提供逐帧 GID，改为保留发布端图快照并将 sequence 统计标为不可用，不把不同发送者混算。unavailable 下的间隔也可能混有多个发布者。固件保留的 sequence 0 回绕不算丢包。
- MCU 与 Jetson 源时钟不可假定同源。只对同发布者源时间戳做间隔统计，不直接用 MCU 时间减 Jetson 时间计算端到端延迟。
- 相邻轨迹结点的加速度差分不是连续曲线 jerk 的上界；不能仅凭该值决定增益或限速。
- 无运动、缺少关键 Topic、丢样、截断文件和故障均须保留为分析限制，不自动给出“正常”结论。

## 开发验证

```bash
npm run test:motion
# 仅隔离 ROS domain：fixture 会发布模拟数据，禁止在生产 Domain 运行
ROS_DOMAIN_ID=227 python3 scripts/motion_diagnostics/ros_smoke.py
```

离线单元测试不依赖 ROS。隔离测试检查 BEST_EFFORT 订阅、锁存 action status、缓存结果读取、按运动统计和 Ctrl+C 落盘；不连接真实电机。
