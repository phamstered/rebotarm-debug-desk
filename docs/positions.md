# 姿态库与 MoveIt2

Motion → **姿态库** 保存当前连接下的关节姿态，并在会话解锁后交给 Jetson 上的 MoveIt2 规划执行。保存、编辑和删除不会发运动指令。连接、切模式和打开页面都不会自动回 HOME。

![已进入 Motion 但控制器尚未激活时的姿态库](/screenshots/positions.png)

![从连接页「管理姿态库」打开的离线姿态库](/screenshots/positions-offline.png)

两张图都没有 Jetson，所以 HOME 是「待同步」「无姿态」，自定义列表是「还没有自定义点位」。连上控制栈之后，卡片左侧才会按保存的关节角画出简化姿态；执行按钮在门禁通过前保持禁用，并把原因写在安全确认旁边。离线时原因是「请先连接 Jetson」。已经连接但轨迹控制器未激活时，原因是「请先激活 arm_trajectory_controller 轨迹控制」。勾选安全确认之前，已连接且控制器就绪时的原因是「请先确认工作区安全并解锁点位执行」。

协议字段见 [Bridge 协议 · MoveIt2](./protocol#moveit2-保存点位执行)；更细的门禁与测试见 [基本功能](./basic-features#motion-工作区)。2026-10-25 的方案记录（独立窗口、`motion_move` 等未采用的接口名）在 [历史方案](./positions-moveit-design)，不以该文的勾选状态判断当前能力。

## 前置条件

执行依赖控制栈和 Bridge，桌面不安装 ROS、不加入 DDS。

1. Jetson 已安装 `rebotarm_moveit_config`，并且能启动 `real_move_group.launch.py`。该 launch 只拉起规划器，不另起硬件、`robot_state_publisher` 或第二个 `controller_manager`。
2. Bridge 编译进 MoveIt 消息支持。未编译时 `position_motion_info` 返回不可用，姿态仍可管理，执行按钮给出原因。
3. 在 **Status → 控制模式** 选择 Trajectory，再点「启动所选模式」。原生流程在轨迹控制器与重力补偿自检通过后，再执行 `ros2 launch rebotarm_moveit_config real_move_group.launch.py`，并等待 `/move_action`、`/move_group/get_parameters`、`/get_planning_scene`。已有就绪规划器会复用；姿态库页没有单独的「启动 MoveIt」按钮。MoveIt 未起来时，界面原因是「MoveIt /move_action 未启动，请启动 real_move_group.launch.py」。
4. 现场控制器配置需关闭 MoveIt 自动切换控制器。执行前 Bridge 再核对 `arm_trajectory_controller` 为 active，并认领 joint1–joint6 的 `position+velocity`。可选夹爪还要独立的 `gripper_trajectory_controller` 与标定参数。

规划失败或规划器未就绪时，轨迹控制器命令流可以仍然保留；界面显示缺少的服务或配置，不会改走本地 IK 或 `/joint_trajectory` 直发。

## 保存姿态

新姿态从 **Motion → Robot View → TCP / 关节操作** 最下方的「保存当前姿态」写入。

- 对话框固定**打开瞬间**的实测快照：六轴优先用连接配置的 JointState（默认 `/stm32/joint_states`），否则 `/joint_states`，且须在 1 秒内完整、有限。之后的反馈和尚未执行的 TCP 预览不会改这组数。
- 只记录关节角（以及可选夹爪），不下发运动。重力补偿下可以把臂拖到目标再保存。
- 可选「保存夹爪目标」。单位在界面是单指行程毫米，文件里是米。不勾选表示执行时保持当前开度，不会写成 0。没有新鲜标定夹爪反馈时，对话框说明当前只采集了六轴，仍可手填毫米值。
- 名称不能为空，不能叫 `HOME`，同一连接内不能重名。

未连接时，连接页「管理姿态库」打开同一份数据，可编辑、删除已有点；没有新鲜反馈时不能从 Robot View 采集新姿态。姿态库页本身不再提供「手动新增」。

自定义点按连接保存：键为 `SSH主机|用户|端口`。文件名仍是应用数据目录下的 `positions.v1.json`，内容 `schemaVersion` 为 2（版本 1 会迁过来，且不补夹爪）。HOME 不写入该文件。

## 锁定的 HOME

列表置顶一行，标识 `builtin:home`，显示名 `HOME`，带「锁定」。

- 界面和保存文件都不能删除、改名或覆盖它。手改 JSON 里的同名或同 ID 记录会被丢掉。
- 数值来自当前 `/move_group` 的 SRDF `arm` / `home`，不是桌面写死的角度，也不是 STM32 RETURN 或上电归零。
- 尚未同步时显示「待同步」，不能执行。不以全零代替。
- HOME 不带夹爪目标，执行时保持夹爪当前开度。

## 执行与取消

1. 勾选「我已确认工作区安全，允许点位运动」。未勾选时原因是「请先确认工作区安全并解锁点位执行」。这是本会话的执行开关，保存姿态不需要它。
2. 点击点位卡片或「移动」。HOME 在 SRDF 已同步后同样可点。请求使用点击时的快照；随后编辑或删除该点不影响已经受理的运动。
3. Bridge 固定走 MoveIt `/move_action`。六轴用 `arm`，仅夹爪用 `gripper`，六轴加夹爪用 `arm_with_gripper`。客户端不能指定别的组、Action 或 Topic。`home:true` 时由 Bridge 读当前 SRDF，忽略桌面传来的角度。
4. 受理 ACK 只表示请求被接受。完成要等 Action 成功，并且新鲜反馈里受控轴速度连续停稳约 200 ms。最终关节位置差会显示，但不再单独作为完成门槛。取消 ACK 也不等于已经停稳；约 5 秒内看不到停稳则显示「停止未确认」并保持锁定。
5. 进行中可点「取消运动」。切到其他页时，全局任务条仍显示阶段，可回到 Motion 或取消**本会话**的运动。其他会话只看到忙碌，不能抢同一条运动。断线由 Jetson 侧取消本会话 goal，重连不会自动重发。

阶段包括校验、规划、执行、到位确认和取消。底部「执行日志 / 执行报告」与 Robot View、动作组共用；断线或重连会清掉上一会话的日志。

点位运动期间，Robot View 的 TCP 拖拽确认走同一套状态机，不能并行再发一条。

## 安全门（执行前与执行中）

不满足时 `available` / `accepted` 为假，并带具体 `message`。这些条件来自当前 Bridge，文档不放宽它们。

- 会话已确认，且本连接拥有该运动。同一时刻全局只有一个点位或动作组运动。`command_id` 重复不会执行第二次。
- `arm_trajectory_controller` active，认领六关节 `position+velocity`。旧的仅 position 接口不能执行。请求不会自动切换控制器。
- 关节反馈、控制器状态、硬件状态新鲜（约 1 秒内）；关节值完整、有限、无重复；硬件为 TRACK、无故障，且六轴在使能掩码内。
- 实测关节速度 ≤ 0.05 rad/s；JTC actual 与 STM32 实测位置差 ≤ 0.02 rad。已不再把 JTC desired/reference 的偏差或连续稳定 200 ms 当作启动条件。MoveIt 仍用新鲜实测状态当起点，并保留自身起点容差。
- 时钟失步时拒绝执行。判断用 Jetson 上的源时间戳，不用 Mac 墙钟。
- 目标在当前模型限位内。速度/加速度缩放为 1.0。服务端需关闭自动控制器管理，起点容差不超过 0.02 rad，速度不超过 2 rad/s，加速度不超过 2 rad/s²（真实入口使用缩放 1/1、速度/加速度 2/2、起点 0.01 rad）。
- 含夹爪时还要求标定反馈新鲜、专用夹爪控制器 active，以及协议中的米制速度、行程和偏差门限。见 [协议 · joint7](./protocol#joint7-夹爪扩展)。
- 规划超过约 180 秒、故障、反馈丢失、配置变化、断线，或会话心跳超过 5 秒，会请求取消。

碰撞检查包括 URDF 自碰撞和 MoveIt Planning Scene 里已经建模的障碍。Robot View 里的 RGBD 点云**不会**写入 Planning Scene，不能当成现场所有物体都已参与避障。

## 和动作组、TCP 的关系

- **动作组**使用已保存姿态的快照编排时间轴，经 `position_group_start` 由 Bridge 逐段规划。姿态库改名或改值不会悄悄改已保存的组。见 [基本功能 · 动作组](./basic-features#motion-动作组)。
- **TCP / 关节确认**也调用 `position_move`（`tcp_pose` 或 `joint_targets`），不是姿态库里的另一套执行器。松手只保留预览，要点「确认执行」才下发。
- 运动不连贯时，用 [只读运动诊断](./motion-diagnostics) 在 Jetson 录规划轨迹和反馈。脚本不发控制指令。

## 当前界面没有的能力

下列条目出现在历史方案里，当前代码没有对应入口：

- 可拖出的独立位置窗口，以及 Robot View 之外的常驻位置面板。
- 「仅规划 / 预览」按钮。一次点击会在门禁通过后规划并执行。
- 在姿态库里手动新增一行空白点。新点只能从 Robot View 采集；已有点可以编辑关节数值。
- 把 RGBD 点云自动加入 Planning Scene。
