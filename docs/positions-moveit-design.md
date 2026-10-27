# 位置管理 Panel 与 MoveIt2 规划方案（Draft）

> 方案日期：2026-10-25 · 跟踪 [Issue #120](https://github.com/phamstered/rebotarm-debug-desk/issues/120)。
> **本页是待审核设计，不是已实现功能。** 本轮只增加方案文档与入口，不修改运行代码、部署配置或现场控制状态。

## 1. 需求与设计结论

| 用户需求 | 拟定行为 |
| --- | --- |
| 一键移动到保存位置 | 点击某行「移动」后，由 MoveIt2 从最新真实状态规划并执行；只有轨迹控制与全部执行条件就绪时启用 |
| 所有情况都支持保存、删除 | 管理操作不依赖连接、控制模式或 MoveIt；离线可手动录入、保存、删除自定义位置。只有「读取当前位置」需要可用的新鲜反馈 |
| 独立 Panel | 新增 `PositionManagerPanel`，与 Inspector、ROS Control 分开；Robot View 下方默认展开，可收起、调整高度 |
| 默认回归 HOME、HOME 不可删除 | HOME 固定置顶、默认选中，提供常驻「回 HOME」按钮；HOME 来自 SRDF 的 `arm/home`，不可删除、改名、覆盖 |
| 使用 MoveIt2 | Jetson `move_group` 负责规划；推荐用 MoveIt 的执行 Action 接入真实 JointTrajectoryController，并显示实际执行结果 |

**「默认回归 HOME」在本方案中的含义**：默认目标为 HOME，点击「回 HOME」才开始运动；连接、启用轨迹控制、保存、删除、重连以及软件启动都不自动移动。该解释列入本次 Draft 的审核项。

首版位置点采用**具名关节位置**，而非只有 XYZ 的点。这样可完整保存机械臂构型，也避免同一 TCP 位置对应不同 IK 解。可附带计算得到的 TCP 位姿用于查看，但执行依据是 `arm` 组关节值；不控制夹爪开合。

## 2. 已核对的配置与现状

### 2.1 参考文件

用户提供的路径：

```text
/Users/jialiang/Project/leader_follower/src/rebotarm_moveit_config/config/rebotarm.srdf
```

`leader_follower` 是 `/Users/jialiang/Project/rebotarm-ros2-stack` 的兼容符号链接。设计核对基线为控制栈 main `69120ac`，Desk main `adb5b4d`。

| 文件 | 已核对事实 | 设计影响 |
| --- | --- | --- |
| `config/rebotarm.srdf` | `arm` 组为 joint1–joint6；有 `home`、`forward` named state；world → base_link 固定虚拟关节 | HOME 按组和名字解析，不复制为全零；夹爪不混入 arm 目标 |
| `config/moveit_controllers.yaml` | `MoveItSimpleControllerManager`；控制器 `arm_trajectory_controller`；`FollowJointTrajectory`；action_ns=`follow_joint_trajectory` | 真机执行地址应核验为 `/arm_trajectory_controller/follow_joint_trajectory` |
| `config/kinematics.yaml` | `arm` 使用 KDL，搜索分辨率 0.005、timeout 0.05 秒 | 新规划复用服务端配置；保存的关节目标不需要桌面 IK |
| `config/rebotarm_moveit.urdf.xacro` / `rebotarm.ros2_control.xacro` | 顶层入口包含 `mock_components/GenericSystem` | 不能把 mock/demo 启动配置当成真机接入已完成 |
| `launch/move_group.launch.py` | 加载 MoveIt 配置；`moveit_manage_controllers=true`；起点容差 0.15；未显式选择真实关节反馈源 | 需要真机专用 launch 与参数审核，不能直接沿用这些执行策略 |
| `launch/demo.launch.py` | 完整 mock 演示入口 | 不在生产 ROS domain 启动 demo，不另建第二个生产 controller_manager |
| Desk 当前轨迹实现 | 本地位置 IK、两点 JointTrajectory、Topic 发布 ACK | 不能把当前「已发布」当作 MoveIt 规划/执行完成 |

当前 SRDF 中的 HOME（单位 rad）：

| 关节 | joint1 | joint2 | joint3 | joint4 | joint5 | joint6 |
| --- | --- | --- | --- | --- | --- | --- |
| `arm/home` | 0 | -0.01 | -0.01 | 0 | 0 | 0 |

这些值只是本次核对快照。实现时由 Jetson 当前有效模型读取 HOME，并返回模型/SRDF 版本；桌面不把这个表硬编码为永久目标。HOME 不是 STM32 的 RETURN 模式，也不是上电归零或零位标定命令。

### 2.2 真机接入需解决的问题

- 一键 Trajectory 当前启动 `start_arm_teleop.sh --position-controller=trajectory`，不能据此认定 `move_group`、规划管线与 Action 已就绪。Status 中分开显示「轨迹控制器」与「MoveIt 规划服务」。
- `move_group` 应读取真实、带时间戳的完整 JointState 与 TF。优先审核 ros2_control 的 `/joint_states`，确认其夹爪 prismatic 单位是米；不能把原始 `/stm32/joint_states` 中的夹爪电机角度直接当作夹爪长度。六个臂关节仍需与 Bridge/控制器反馈一致。
- 对齐 URDF/SRDF 的 robot 名称、group、joint、fixed tool transform、碰撞体、关节限位与固件实际可接受范围。SRDF 的 `forward` 值不能直接认定为真机可执行位置。
- 核验 SRDF `end_effector` 的 `group="arm"` / `parent_link="link6"` 语义与 KDL 链；保存点不依赖该末端定义，但后续 TCP Pose goal 需要明确 `gripper_link` 与 `link6` 的固定变换。
- 真实 launch 不启动 mock 硬件、额外 robot_state_publisher 或竞争的 controller_manager；`use_sim_time=false`，与当前硬件、Bridge 的 ROS_DOMAIN_ID 及 DDS profile 一致。
- 禁止 MoveIt 自动激活/切换控制器；真机 launch 明确设置 `moveit_manage_controllers=false`，并用测试验证实际插件行为。用户先显式启用轨迹控制，执行前再次检查 active 状态和接口归属。
- 重新审核 0.15 rad 的起点容差；不能将它当成真机安全默认值。规划、执行起点门禁使用同一配置与测试基线，禁止放宽容差掩盖反馈失配。

本轮 Jetson SSH 读取因连接超时未成功，因此没有核验现场 MoveIt 安装版本、Action 定义及服务状态；以上配置事实来自本地控制栈，运行检查属于实施验收。

## 3. 独立位置管理 Panel

### 3.1 布局与入口

Panel 默认在 Topics 工作区 Robot View 下方，包含管理工具栏、位置表、详情/编辑区及运动状态区。支持收起、展开和调整高度；窄宽度时详情改为行内展开，按钮换行，不覆盖 3D 手柄或全局工具条。

为满足离线管理，连接首页增加「管理位置」入口，打开同一个 Panel；连接后保留全局「位置」入口。管理组件不依赖 Topics 的 ROS 就绪门禁，切到 Status/其他页也能打开。编辑草稿不会被状态轮询或实时 JointState 覆盖。

```text
位置管理                         轨迹控制：ACTIVE | MoveIt：就绪
[读取当前位置] [新增/保存] [回 HOME] [收起]

默认   名称         来源 / 配置兼容性       操作
★      HOME 🔒      SRDF arm/home           [移动] [详情]
       取料位       用户保存 · 匹配          [移动] [编辑] [删除]
       旧工作位     模型版本不同            [移动禁用] [编辑] [删除]

执行状态：空闲 / 规划中 / 执行中 / 取消中 / 完成 / 失败
详情：joint1–joint6、TCP 摘要、采样时间、备注
```

### 3.2 操作矩阵

| 状态 | 查看 / 手动保存 / 删除自定义点 | 读取当前位置 | 移动 / 回 HOME |
| --- | --- | --- | --- |
| 未连接 | 可用 | 不可用，提示没有实时反馈 | 不可用 |
| 已连接、未启用轨迹控制 | 可用 | 新鲜、完整反馈时可用 | 不可用 |
| Teleop / VLA / 标定模式 | 可用 | 新鲜、完整反馈时可用 | 不可用，提示需先切到轨迹控制 |
| 轨迹控制已启用，MoveIt 未就绪 | 可用 | 新鲜、完整反馈时可用 | 不可用，显示缺少的服务/配置 |
| 轨迹控制与 MoveIt 全就绪 | 可用 | 可用 | 空闲且通过执行门禁后可用 |
| 规划或执行中 | 可管理其他点；编辑/删除目标点不改变已接受的运动快照 | 新鲜反馈时可用 | 新运动拒绝，保留「取消」 |
| 断线 / 反馈过期 / 硬件故障 | 可用 | 不可用 | 不可用；执行中按服务端取消流程处理 |

「所有情况都可保存」指保存用户已填好的有效关节值，不以控制器状态阻挡。无实时反馈时仍可手动录入；没有任何值时不伪造全零位置。断线前已复制到编辑器的草稿可继续保存，并保留来源/时间；不以保留上一会话的实时 ROS 消息来实现离线管理。

保存校验名字、关节唯一性、有限数值与数组一致性。超出当前模型限制的自定义值可作为不可执行草稿保存并标注原因，不能被执行通道接受。删除普通点需要轻量确认，与硬件确认无关；HOME 在 UI 和存储层都禁止删除/覆盖。

## 4. HOME 与持久化

### 4.1 HOME 的来源和保护

- 固定保留 ID `builtin:home`，显示名 `HOME`、类型 `srdf_named_state`，绑定 `group=arm`、`state=home`，置顶且默认选中。
- 服务端从当前有效 `robot_description_semantic` 的 RobotModel/SRDF 解析 named state；对照安装包中的 SRDF 版本，报告组、关节集合、数值及模型 hash。
- 自定义位置不得使用 HOME 的保留 ID 或冒充内置类型；手改/导入 JSON 也不能删掉或覆盖内置 HOME。
- 离线时可显示上次验证的 HOME 缓存及版本；首次没有模型时仍显示锁定的 HOME 占位行，数值标为「待同步」，移动不可用。
- SRDF 缺少 HOME、HOME 越界/碰撞或模型版本不一致时保留该行并显示错误，禁止移动；不悄悄回退到全零或任意其他 named state。
- 删除当前默认的普通点后选择 HOME；不触发任何运动。用户保存点不会写回 SRDF。

### 4.2 存储结构（拟定）

采用 Tauri app data 下的 `positions.v1.json`，版本化 JSON、原子写入和损坏文件备份；业务校验在纯逻辑层，文件路径由原生命令固定，不让 WebView 提交任意路径。

| 字段 | 用途 |
| --- | --- |
| `schemaVersion` | 存储迁移版本 |
| `robotId` / `profileId` | 用户选择的机器人身份与连接配置关联，SSH alias 不单独作为机器人身份 |
| `modelFingerprint` | URDF、SRDF、关节限位/顺序与工具配置版本；变化时标记待重新确认 |
| `id`, `name`, `group` | UUID、用户名称、规划组 |
| `jointNames`, `positions` | 按名字保存的组关节值，不依赖消息到达顺序 |
| `source`, `capturedAt`, `createdAt`, `updatedAt` | manual / feedback、采样及编辑审计时间 |
| `tcpFrame`, `tcpPose`, `note` | 可选显示信息，TCP pose 不作为首版执行真值 |

HOME 的语义引用由程序合成，缓存与用户点分开；实际执行值始终由服务端当前模型解析。多机器人数据不混用；模型改变时保留点和删除能力，但执行禁用，需显式重新绑定或重新保存。

## 5. MoveIt2 规划与执行架构

### 5.1 推荐通道

```text
PositionManagerPanel / 后续 Robot View Pose goal
  → 现有 SSH 隧道 / WebSocket Bridge（受控请求与单会话运动所有权）
  → Jetson MotionPlanner 适配层
  → moveit_msgs/action/MoveGroup：plan_only=true，replan=false
  → 服务端校验完整 RobotTrajectory 与当前执行条件
  → moveit_msgs/action/ExecuteTrajectory
  → MoveItSimpleControllerManager（只配置允许的 arm 控制器）
  → /arm_trajectory_controller/follow_joint_trajectory
  → 真实 ros2_control / MicroRosSystem / STM32
```

采用规划、校验、执行三个内部阶段，一次「移动」点击自动串联，不额外增加每次预览确认。另提供「仅规划/预览」入口供调试，绝不触发执行。真机确认沿用会话内已有安全确认策略，执行按钮始终清楚显示目标。

MoveIt2 在 Jetson 运行，Mac 不安装 ROS、不加入 DDS。适配层放在 Bridge 的独立 C++ 模块，限制 planning group、Action 名称与允许控制器；不开放任意 ROS Action 或 shell 命令。

**Humble 接口注意**：`ExecuteTrajectory` goal 只有 `RobotTrajectory trajectory`，不能照搬新版接口的 `controller_names` 字段。控制器选择由已审核、只含目标 arm 控制器的 `moveit_controllers.yaml` 决定，Bridge 再核对实际 active 控制器、关节集合与 Action。依赖及头文件以 Jetson 安装的 Humble 为准；无 MoveIt 编译支持时能力明确为 unavailable，其他只读和位置管理仍可用。

### 5.2 关节目标与 HOME

- HOME 由服务端解析 named state；普通位置点通过每个组关节的 `JointConstraint` 构造目标。
- 起点由 MoveIt 的新鲜完整真实状态构造，不使用保存点采样时的起点，也不在状态不全时用零补齐。
- 规划组固定允许 `arm`；关节必须与模型及 active JTC 的六个关节一致。名字映射后排序，不夹带夹爪或额外关节。
- 使用控制栈的规划管线（首版 OMPL）和限位配置；速度/加速度缩放使用可审阅配置，首个真机基线建议从 0.1 起，最终值在 mock/仿真和现场验收后确定。
- 保留 MoveIt 规划出的全部有效点及时间参数，不压成旧实现的两个点；不把其重采样当成保持碰撞安全的等价操作。
- 规划成功后再次验证起点偏差、配置及碰撞环境几何版本；超过允许起点偏差或环境几何发生变化时拒绝该计划并提示重新规划，不静默执行旧计划或无限自动重试。普通 JointState 时间戳更新不等同障碍物几何变化，不能因此使所有计划失效。

### 5.3 状态、成功与取消

状态机：`idle → planning → validating → executing → succeeded / failed`；规划和执行均可进入 `canceling → canceled / stop_failed`。

- 点击后立即显示目标、阶段、耗时；展示 MoveIt error code、控制器拒绝/超时原因和跟踪误差。
- WebSocket 请求 ACK 只表示受理。只有执行 Action 返回成功，且终点反馈新鲜、满足关节误差/停止速度门限时显示「完成」。目标容差与停止门限属于配置和验收项，不把本地 IK 的 5 mm 误差当作关节执行容差。
- 「取消」发送对应 goal 的取消请求，等待取消结果与停止反馈；取消 ACK 不等于机械臂已停稳。失败显示「停止未确认」，保留既有安全停机入口。
- 同一机械臂只允许一个活动运动，约束覆盖多个 WebSocket 客户端；`command_id` 去重，同一点击的网络重试不能重复执行。
- 运动目标采用不可变快照：删除或编辑保存点只影响后续请求。用户要中止正在运行的动作必须点击取消。
- 断线、控制器失活、硬件故障、反馈丢失时由 Jetson 侧 watchdog 取消本会话拥有的运动；不能依赖已经关闭的网页继续发取消。重连仅查询该动作的最终/未知状态，不恢复或重发。
- 普通取消不直接等同 DISABLE；保持/停止与必要时解除输出仍遵守现有 STM32 生命周期、重力补偿及故障锁存策略，不能为退出方便停掉仍在维持控制心跳的进程。

## 6. 执行门禁与 Planning Scene

每次规划前、执行前以及执行中分别检查，失败返回具体阶段和原因：

1. 当前连接与控制所有权有效；用户显式启用轨迹控制且会话安全确认有效。
2. 指定的 JTC 为 active，动作服务器可用、独占所需 position 接口；Teleop/VLA/标定无冲突，不能靠自动切换规避门禁。
3. JointState、ControllerState、HardwareStatus 新鲜（延续当前 <1 秒门限）；arm 关节完整、无重复、有限值，硬件无故障，active mask 足够。
4. MoveIt 当前 RobotModel、SRDF、组、HOME/目标、JointState 单位和 TF 与实际硬件一致；目标满足模型和部署允许范围。
5. MoveIt 规划结果成功且非空；轨迹关节集合、数组维度、有限值、递增时间、起止状态、关节限位与速度/加速度约束通过服务端校验。
6. 使用当前 Planning Scene 检查自碰撞和已知环境碰撞。配置/SRDF 免检对必须审核，不能为通过 HOME 自动扩大免检范围。
7. 带时间参数的完整轨迹大小和执行时长受限；实施时在控制栈基准路径上确定 MoveIt 专用点数/时长/字节上限，并覆盖超限失败。旧 Topic 路径 64 点限制不能被静默删除，也不能让新路径无界接收数据。

首版可包含已建模的地面、桌面与固定障碍，但未录入场景的物体无法避障。RGBD 点云方案尚未落地，不能宣称本功能已经感知相机画面中的障碍。场景来源及更新时间需可见。

## 7. 拟新增接口（均未实现）

不在当前 [已实现协议](./protocol) 中把这些操作写成已支持；实施时同步 `src/types.ts`、Bridge、测试和协议。

| 操作 | 请求/返回重点 | 权限与行为 |
| --- | --- | --- |
| Tauri `positions_load` / `positions_save` | 版本化用户点列表、固定 app data 路径、HOME 保留 ID 校验 | 离线可用，不访问 ROS |
| Bridge `motion_capabilities` | MoveIt 可用性、模型 hash、group、joint_names、named HOME、控制器/Action/scene 状态 | 只读；状态分阶段，不只返回一个 ready 布尔值 |
| Bridge `motion_move` | `command_id`、`target`（named HOME 或关节映射）、期望模型 hash、规划组、已确认会话；可选 `plan_only` | 后端独立做执行门禁；前端 enabled 不是授权依据 |
| Bridge `motion_status` | `command_id`、阶段、目标快照、MoveIt/Action 状态、最终误差、错误 | 可查询，重连不隐式重试 |
| Bridge `motion_cancel` | 会话拥有的 `command_id` | 只取消属于该会话的 goal，不取消其他 ROS 应用动作 |
| Bridge `motion_event` | 命令 ID、阶段、结果、错误码、序号 | 单调事件序列；旧会话响应不污染新界面 |

客户端不能提交任意 ROS Action 名称、规划组或已计算的 RobotTrajectory 绕过规划。HOME 目标示例（仅设计）：

```json
{
  "op": "motion_move",
  "request_id": "uuid",
  "command_id": "uuid",
  "model_fingerprint": "expected-model-hash",
  "group": "arm",
  "target": { "kind": "named_state", "name": "home" }
}
```

安全确认由现有会话确认门禁传递和校验，不能因为报文里写了一个字符串就认定通过。原 `trajectory_command` 在迁移期保持既有受控行为，但新位置管理不得在 MoveIt 失败时回退到本地 IK 或 Topic 直发。后续所有 Robot View 新规划入口统一到该适配层，避免长期保留两套用户可混用的执行方式。

## 8. 跨仓实施与当前规范差异

| 仓库 / 位置 | 拟改动 |
| --- | --- |
| Desk `PositionManagerPanel.tsx`、`positionLogic.ts`、`motionLogic.ts` | 独立管理 UI、离线存储校验、运动状态机、超时/取消、3D 预览；会话编排接入 App |
| Desk Tauri 模块 | 固定路径文件存储与原子写入；一键轨迹模式显式启动/检查经过审核的真机 MoveIt launch，不执行任意用户命令 |
| Bridge 独立 motion planner 模块 | MoveGroup/ExecuteTrajectory clients、SRDF/模型元数据、轨迹校验、并发所有权、watchdog、结果事件及能力协商 |
| `rebotarm-ros2-stack/rebotarm_moveit_config` | 真机专用 launch、真实反馈与 TF、SRDF/RobotModel 核验、OMPL/限位/时间参数、FollowJointTrajectory 控制器配置；启动不争抢已有控制进程 |
| 用户文档 / 测试 | 功能、架构、协议、故障码、部署依赖和端到端验收；Bridge 变更后重新生成 build ID |

**实施前必须确认的规范变更**：当前 AGENTS.md 规定轨迹只发送到 JTC 的 `/joint_trajectory` Topic；本方案推荐的 MoveIt 执行通道使用 `FollowJointTrajectory` Action。Draft 只提出该差异，不直接修改或绕过当前规则。正式功能 PR 应同时提交并经人工审核：扩展为「既有 Topic 通道 + 受限 MoveIt Action 通道」，保留 active、白名单、反馈、限位、故障、确认和取消门禁。

如暂不接受 Action 通道，备选为 MoveIt 仅规划、Bridge 校验后走既有 Topic 执行；该方案不能获得同等的 Action 执行结果/取消语义，需要另行设计和验收，不能以发布 ACK 冒充完成。推荐采用完整 Action 通道。

## 9. 分阶段任务与验收

### A. 位置管理与真机配置基线

- [ ] 确认本 Draft 的默认 HOME、存储、Panel 入口及 Action 通道决策。
- [ ] 实现离线用户点 CRUD、固定 HOME 与机器人/模型绑定，不增加任何运动副作用。
- [ ] 独立核验真实 RobotModel、SRDF `arm/home`、反馈单位/时间戳、TF、碰撞体与控制器，增加真机专用 MoveIt launch；mock 与真机入口分开。
- [ ] 确认 Humble 的实际消息/Action 版本与依赖；能力缺失时只禁用移动，保留管理功能。

### B. 保存点 / HOME 一键 MoveIt 运动

- [ ] 实现服务端规划→校验→执行、单命令所有权、幂等、超时与取消。
- [ ] 接通 Panel 的移动、回 HOME、仅规划预览、执行结果及错误反馈。
- [ ] 在与生产隔离的 ROS_DOMAIN_ID 中，用真实 move_group + mock hardware + JTC 验证完整 Action 链；包含离线管理、HOME 保护、规划失败、旧模型、旧起点、冲突/重复命令和取消失败。
- [ ] 通过现场安全确认后进行受限真机验收，记录目标、计划、Action result、实际关节/TCP 误差、停止与故障状态，不仅验证 ACK。

### C. Robot View 统一规划

- [ ] 拖拽松手生成带 frame 的 TCP Pose goal，通过同一 MoveIt 后端规划；不再让桌面位置 IK 决定实际执行轨迹。
- [ ] 明确 TCP→MoveIt tip 固定变换；默认保存拖拽起始姿态作为目标姿态。若提供 position-only 模式，应作为明确选项独立验收。
- [ ] 本地 IK 可仅作为临时可视化预览，但不能被误认为 MoveIt 碰撞检查后的计划，失败不回退执行。
- [ ] 保存点/Home 与拖拽共用运动互斥、取消、状态和结果，验证导航切换、断线、重连不会重复执行。

### 测试矩阵

| 层 | 需要覆盖 |
| --- | --- |
| 前端逻辑 / 组件 | 所有模式可保存删除；未连接手动保存；读取当前位置前提；HOME 不可删改；轮询不覆盖输入；大小屏不遮挡；模型不匹配；按钮禁用原因与运动状态 |
| Tauri | 固定存储路径、schema 迁移、保留 ID、有限值/重复关节、原子保存失败恢复、损坏数据处理与多机器人隔离 |
| Bridge | group/Action/控制器白名单、能力缺失、有限值/维度/时间/资源上限、起点漂移、去重、跨客户端互斥、断线 watchdog、Action 拒绝/失败/取消和乱序响应 |
| ROS 隔离集成 | HOME 从 SRDF 真正解析；mock 与真实配置隔离；MoveIt 真实规划/碰撞/Action 执行；关节名乱序、额外夹爪、场景变化、反馈过期、控制器失活及停止确认 |
| 人工现场 | 先确认安全，再验证低速小幅点位与 HOME；记录实际误差和故障码；未通过时不得宣称已支持真机一键回归 |

功能实施必须执行全量 `npm test`、`npm run build`；文档构建 `npm run docs:build`。涉及 Bridge/控制栈时另执行 ROS `colcon build` / `colcon test` 和隔离端到端，按规范部署、校验当前进程与 Bridge build ID。此 Draft 不包含硬件验证结果。

## 10. 本次审核决策

1. HOME 为默认目标和显式「回 HOME」操作，不在连接/切模式时自动运动。
2. 首版保存的是六关节位置，夹爪开合不随点位保存/执行；TCP 位姿为辅助显示。
3. 保存/删除永远独立于控制可用性；读取真实当前位置需要反馈，离线采用手动值/已填写草稿。
4. 推荐 MoveIt2 完整 Action 执行通道及对应 AGENTS 规范变更；HOME / 用户点先落地，Robot View 随后统一到同一规划服务。
5. 本轮只交付方案 Draft；后续运行代码与控制栈变更另开功能 PR 审核。

## 11. 参考依据

本地配置事实来自上述控制栈文件；API 与架构参考优先使用 Humble 文档与消息分支：

- [MoveIt2 Humble：move_group 概念与配置输入](https://moveit.picknik.ai/humble/doc/concepts/move_group.html)。
- [MoveIt2 Humble：控制器配置与 FollowJointTrajectory](https://moveit.picknik.ai/humble/doc/examples/controller_configuration/controller_configuration_tutorial.html)。该页部分调试示例仍标记 ROS 2 待更新，实际接口以 Humble 定义为准。
- [moveit_msgs Humble：MoveGroup.action](https://github.com/moveit/moveit_msgs/blob/humble/action/MoveGroup.action)。
- [moveit_msgs Humble：ExecuteTrajectory.action](https://github.com/moveit/moveit_msgs/blob/humble/action/ExecuteTrajectory.action)。
- [moveit_msgs Humble：PlanningOptions.msg](https://github.com/moveit/moveit_msgs/blob/humble/msg/PlanningOptions.msg)。
