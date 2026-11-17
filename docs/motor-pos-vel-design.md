# MIT / POS_VEL 电机控制兼容方案（Draft）

> 日期：2026-11-17 · 跟踪 [Issue #281](https://github.com/phamstered/rebotarm-debug-desk/issues/281)。同日并入 rebotarm-debug-desk、rebotarm-ros2-stack、rebotarm-executor 三仓房间共识。
> **本文全部新增接口及行为均为待实现方案。本 PR 只提交设计，保持 Draft，不部署、不驱动电机，也不开始实现。** 当前功能仍以 [基本功能](./basic-features#_6-mit-电机控制) 和 [协议](./protocol) 为准。该 Issue 只验收方案；后续跨仓功能实施另建 Issue。POS_VEL 不写入已交付功能文档。

## 1. 推荐结论

保留现有 MIT 控制路径，将 **执行状态**、**电机驱动模式**、**参数预设** 分成三个概念。通过独立 V2 协议增加 POS_VEL，不把它塞进现有 `mode=0..3`，也不靠 Kp/Kd 推断。

| 概念 | 示例 | 含义 |
| --- | --- | --- |
| 执行状态 `mode` | HOLD / TRACK / RETURN / DISABLE | 固件是否输出、如何接受目标、超时后如何停止；保留原数字及停止语义 |
| 驱动模式 `control_mode` | MIT / POS_VEL | 电机使用哪种 CAN 编码及内部控制器，必须由固件切换并核验 |
| 参数预设 `preset` | 自定义、某组 MIT 增益、某组 POS_VEL 速度上限 | 只填写表单，不切驱动、不使能、不发命令；不进入固件状态枚举 |

首版范围是 **Motor 页手动调试的 POS_VEL**：同一任务的所选关节使用同一种驱动模式，逐关节位置与速度上限，继续 20 Hz 命令流。内部能力和反馈按关节建模。首版不开放逐轴混合模式，也不在周期命令流里交替 MIT 与 POS_VEL；以后若要分轴使用不同驱动，只能在任务边界经切换事务完成。`MicroRosSystem`、Teleop、Trajectory、JTC、VLA、示教与重力辨识留在 V1 MIT，不订阅 V2，不写电机 PID/Flash 参数。

关键约束：旧协议永远只代表 MIT；POS_VEL 不得自动降级为 MIT；模式切换必须在已确认输出关闭时完成；任何模式下都保留现有 DISABLE 入口。2026-11-17 三仓否决在旧 `JointCommand` 末尾追加 `uint8 drive_mode`，改为独立 V2。细节见下一节。

## 房间共识（2026-11-17）

2026-11-17，rebotarm-debug-desk、rebotarm-ros2-stack 与 rebotarm-executor 对齐下列约束。此前考虑过在旧 `JointCommand` 末尾追加 `uint8 drive_mode`，**该方案明确否决**；三仓改为独立 V2。本节记录已同意的边界。台架未核项仍标为未解决，记录共识不开始实现。

### V1 协议冻结

MCU 仍订阅 `/stm32/joint_commands`，类型为 `microros_stm32h723_bridge/msg/JointCommand`。布局保持不变：`header`、`sequence`、`mode`（0=HOLD，1=TRACK，2=RETURN，3=DISABLE），以及 `float32[7]` 的 `position`、`velocity`、`kp`、`kd`、`effort`（joint1–6 与夹爪）。V1 永远只表示 MIT。不向该消息增加 `drive_mode` 或任何 POS_VEL 字段。

原地追加字段被否决。它会改变 ROS 2 CDR 与类型哈希，未重编译的节点无法互通。旧 Bridge 还可能忽略新的 JSON 字段，仍按 MIT 发布。Desk、Bridge 与固件经常分开升级，这是危险的混合部署。

### 独立 V2 路径

POS_VEL 走独立 V2：新类型如 `JointCommandV2` 与 `MotorControlStatus`、模式配置服务，以及 Topic `/stm32/joint_commands_v2`（或等价名称）。V2 IDL 放在现有 `microros_stm32h723_bridge` 包内，MCU 静态库与 Jetson typesupport 一起生成。任何实现之前先估算 micro-ROS 内存。

首刀只做 Motor 页手动 POS_VEL。`MicroRosSystem`、Teleop、Trajectory、JTC、VLA、示教与重力辨识留在 V1 MIT，不得订阅 V2。

### 专用驱动模式切换与寄存器读回

切换是独立事务。不能从周期命令的类型推断当前驱动，也不能把切换塞进 `/stm32/joint_commands` 或 V2 周期帧。达妙 CTRL_MODE（RID=10）是寄存器事务，不是逐帧字段。

约定顺序：

1. 停止，并发送 DISABLE。
2. 证明输出已经关闭。
3. 固件写入 CTRL_MODE（RID=10）。
4. 逐轴读回必须与目标一致。
5. 状态只上报**已确认**的模式。
6. 此后才允许该模式的周期命令。

发布成功、ACK、界面下拉选择或“已请求切换”都不是成功。只有确认过的寄存器读回算数。读回失败时保持失能，报告逐轴实际模式，不进入 TRACK，也不假定切换已经发生。

周期流中混用 MIT 与 POS_VEL 帧必须拒绝。做法是在任务边界分阶段切换（示教 / 阻抗 / MIT，相对 PTP / 位置+速度），不在 250 Hz 流里交替两种编码。

已有 `damiao_ensure_control_mode` 不能原样用于在线切换：它不先核验 DISABLE，位置缺失时可能代以 0，会忽略部分 CAN 发送结果，并且可能阻塞。须把“失能态写入 + 逐轴读回”从 250 Hz 环拆出。若某电机只能在使能状态下改模式，该型号不支持 v1 在线切换。

### 仲裁与控制栈

下列准入规则是规范性的。固件在同一准入点执行，不能只靠 Desk 藏起按钮。

1. 准入只使用固件读回确认的实际驱动模式。命令自己声称的模式，以及它携带的 `control_mode`，都不是准入依据。
2. 周期命令必须与该已确认模式一致。已确认 MIT 时，只接受 V1 MIT 帧。已确认 POS_VEL 时，只接受 V2 POS_VEL 帧。不一致则拒绝执行，保持当前输出策略，不改寄存器，不静默降级，也不照样执行。不匹配的帧不是隐式切模式。
3. 模式切换进行中，或各轴模式不一致时，拒绝运动命令，只接受停止。
4. 唯一例外是 V1 `mode=3` DISABLE。任何驱动模式下都必须接受它，机械臂因此总能停下。非 MIT 时不接受 V1 RETURN，避免把 MIT 增益写进位置环。
5. POS_VEL 被占用期间，V1 `/stm32/joint_commands` 只表示 MIT，除 DISABLE 外一律拒绝。
6. V2 帧声明的 `control_mode`（或等价字段）也必须与已确认模式一致。不一致是拒绝，不是切换请求。
7. 拒绝必须出现在现有状态或故障通道上，Desk 要能显示。只写日志不够。

放行旧 ros2_control 栈之前，整组必须确认回到 MIT，并且 V2 lease 已经释放。在此之前不启动 Teleop、JTC 或示教。`lease`、`boot_id`、`control_epoch` 在上述固件准入点强制执行。

Desk 与 Bridge 的 V2 操作必须走现有 Rust `motor_task`、控制占用、停止证明和重启恢复，不能只改 React 与 Bridge。Motor 页以固件确认的实际模式为真值；下拉框在“应用驱动模式”完成前只是候选。

### 已同意的参数与范围

POS_VEL 的 `velocity_limit` 是速度上限，不是 MIT 的有符号速度前馈，不复用 MIT 速度草稿。`kp`、`kd`、`effort` 不得进入 POS_VEL；非零是错误，不是静默丢弃。首版 POS_VEL 不提供 RETURN（回零以后再做）。joint7 可以等待单独验收。

上电默认仍是 MIT。当前 250 Hz 输出只有 MIT（CAN ID 等于电机 ID，8 字节 MIT 打包）。固件库里已有 POS_VEL 编码（CAN ID `0x100 + motor_id`，小端 `position` 与 `velocity_limit`），尚未接到周期路径。这与 §2 已核对的“输出固定 MIT、编码未接入”一致；本轮没有为这句话重读固件源码。

### 仍待台架，不视为已解决

- POS_VEL 在 vel=0 时的保持语义，以及方向与单位。
- 驱动处于失能时，寄存器是否真的可以改写。设计要求在失能态写入；若台架证明不能，该型号的在线切换不在 v1 范围内。
- 当前固件 fault 11 锁存会拒绝新命令，包括 DISABLE。锁存期间仍受理、且不清锁存的幂等 DISABLE 是拟新增的固件行为。旧固件没有这一行为。

## 2. 已核对事实与证据

本次查阅的是源码，不代表 Jetson 当前进程、STM32 或电机已部署这些版本。Desk 基线 `273c8ec`；本地 ROS 栈 `8e9b2381`、executor `0be9d119`，并通过 GitHub API 复核远端 main：ROS 栈 `412d4f47`、executor `f5078325`，下表上游链接固定到该远端版本。实施前仍须对齐实际部署版本。

| 来源 | 已确认事实 | 对设计的影响 |
| --- | --- | --- |
| [Desk motorLogic.ts](https://github.com/phamstered/rebotarm-debug-desk/blob/273c8ec/src/motorLogic.ts)、[MotorControl.tsx](https://github.com/phamstered/rebotarm-debug-desk/blob/273c8ec/src/MotorControl.tsx) | `mode=0..3`；位置数组、共享 velocity/kp/kd/effort；默认 TRACK、Kp=8、Kd=2；模式选择本身没有自动套用一组新 Kp/Kd | UI 的“MIT 命令模式”名称容易混淆，需改为独立执行状态和驱动模式 |
| [Bridge 发布入口](https://github.com/phamstered/rebotarm-debug-desk/blob/273c8ec/bridge/easy_debug_bridge/src/bridge_node.cpp) | `joint_command` 解析已知字段，发布旧 `JointCommand`；未知附加字段不会让旧路径识别 POS_VEL | 单纯附加 `control_mode` 到旧 op 不足以保证兼容安全 |
| [ROS JointCommand.msg](https://github.com/phamstered/rebotarm-ros2-stack/blob/412d4f47c1cb0544b2390fbc09d2152d3c1525a2/src/plugin/microros_stm32h723_bridge/msg/JointCommand.msg)、[HardwareStatus.msg](https://github.com/phamstered/rebotarm-ros2-stack/blob/412d4f47c1cb0544b2390fbc09d2152d3c1525a2/src/plugin/microros_stm32h723_bridge/msg/HardwareStatus.msg) | 命令为 sequence、mode 和五组 `float32[7]`；状态没有驱动模式字段；命令没有逐轴 enable mask | 不原地修改旧 ROS 类型。追加 `drive_mode` 会改变 CDR / 类型哈希，三仓已否决；V2 另立类型 |
| [executor motor_bridge.c](https://github.com/phamstered/rebotarm-executor/blob/f50783251bd16218ad6fd1441a48be7545c38f9b/User/motor_bridge.c) | 初始化固定确保 MIT；控制输出固定 MIT。HOLD 锁存实测位置；TRACK/RETURN 当前共享目标输出路径；TRACK 指令超时 100 ms 后进入 HOLD；非 DISABLE 超过 500 ms 锁存 fault 11，仍有电机使能时保持 HOLD，否则进入 DISABLE | HOLD / DISABLE / watchdog 是状态机，不是增益模板；不能承诺当前固件 500 ms 后必然关闭输出 |
| [executor damiao_protocol.c](https://github.com/phamstered/rebotarm-executor/blob/f50783251bd16218ad6fd1441a48be7545c38f9b/User/damiao_protocol.c) | 已有 `damiao_encode_pos_vel_cmd(target_position, velocity_limit)` 和模式切换工具，但 ROS 电机链路尚未接入 | 可复用编码。`damiao_ensure_control_mode` 不能原样做在线切换；准入、读回和停止仍须另做 |
| [dmBots SDK control_Pos_Vel](https://github.com/dmBots/motor-sdk/blob/main/Python%E4%BE%8B%E7%A8%8B/u2can/DM_CAN.py) | 独立位置速度命令将两项浮点值写入 CAN 帧，使用 `0x100 + motor_id` | POS_VEL 是不同驱动协议，不是 MIT 换一组增益；SDK 示例不能证明现场速度零值或停止行为 |
| [原生 Motor 任务](https://github.com/phamstered/rebotarm-debug-desk/blob/273c8ec/src-tauri/src/session/motor_task.rs)、[恢复记录](https://github.com/phamstered/rebotarm-debug-desk/blob/273c8ec/src-tauri/src/session/motor_recovery.rs) | 原生层持有 Motor 占用、指令流 watchdog、DISABLE 反馈确认与重启恢复 | 新 op 必须进入同一任务和恢复路径，不能只修改 React 与 Bridge |

ROS 栈的 [micro_ros_system.cpp](https://github.com/phamstered/rebotarm-ros2-stack/blob/412d4f47c1cb0544b2390fbc09d2152d3c1525a2/src/plugin/microros_stm32h723_bridge/src/micro_ros_system.cpp#L380-L403) 在停止流程里对 RETURN 插值回零再 DISABLE；固件 RETURN 本身不规划轨迹。另需注意：当前 executor 在 fault 11 锁存后拒绝新命令，包含 DISABLE。界面随时可请求 DISABLE，不代表旧固件一定接受或输出已关闭；本方案不会把 ACK 当停机证明。

因此，“现在只支持 MIT”对当前端到端控制链路成立；“TRACK/RETURN 只是 Kp/Kd 模板”并不准确。两者目前共享 MIT 输出，但承担执行状态及上层生命周期语义，HOLD 更有独立的位置锁存行为。

## 3. 参数与执行状态语义

### 3.1 两套独立参数模型

| 项目 | MIT（保持现有语义） | POS_VEL（拟新增） |
| --- | --- | --- |
| 位置 | `position`，沿用当前电机坐标 | `position`，使用同一电机坐标及轴映射 |
| 速度 | `velocity`，有符号目标速度 | `velocity_limit`，速度上限幅值；不得复用 MIT 有符号速度草稿 |
| 增益 | 每帧 Kp/Kd | 帧中没有 Kp/Kd；电机内部环参数另行管理 |
| 力矩 | `effort` 前馈，继续 `[-1, 1] Nm` 限制 | 无前馈力矩入口，不将 MIT effort 静默丢弃后执行 |
| 首次表单 | 继续已有默认值 | 速度未配置时禁止开始；用户显式“使用当前位置”后填位置，进入模式不自动发送 |
| 数值验证 | 有限值及现有限制 | 有限值，含转为 float32 后仍有限；移动速度必须为正，最大值来自已核验的设备能力 |

POS_VEL 的正值速度上限是新契约，不能靠对负数取绝对值、给零值偷偷补默认值或统一硬编码上限实现。`0` 的设备语义、单位、最大速度、加减速参数必须按实际型号/版本核验；未知时该轴 POS_VEL 显示“未就绪”。不改变 MIT 的 Position / Velocity / Kp / Kd 输入范围。滑块行程仍只是 UI 范围，真正限位由固件/已核验配置裁决。

V2 只接收对应模式的参数块。POS_VEL 中非零的 `kp`、`kd` 或 `effort` 是错误，不得静默丢弃后继续执行。`velocity_limit` 只表示速度上限，不得填入 MIT 有符号速度前馈草稿。不能复用同一组隐藏输入；MIT 与 POS_VEL 草稿分开保存，切换后清除授权。

关节索引、符号、传动比、零偏以固件的既有映射为准，不能再次套一层 ROS 关节转换。首版不默认开放 joint7：Motor 原始夹爪电机坐标和 Motion 的米制夹爪目标不同，需有独立型号/映射验收才能将 joint7 标为 POS_VEL 可用。

### 3.2 支持矩阵

| 执行状态 | MIT | POS_VEL 首版 |
| --- | --- | --- |
| TRACK | 保持当前五通道跟踪 | 位置 + 逐轴速度上限跟踪 |
| HOLD | 保持固件实测位置锁存及现有控制策略 | 进入时锁存新鲜实测位置，不得继续追旧目标。vel=0 的保持语义、方向与单位仍待台架，未核验前这一格不是已实现策略 |
| RETURN | 保持原目标跟踪，不改现有 RETURN → DISABLE 生命周期 | 首版不开放用户选择；返回 `unsupported_state`。后续单独实现速度受控返回和到位/停稳条件 |
| DISABLE | 现有零字段、三帧新序列及停止确认 | 同一高优先级入口；固件按各轴实际驱动模式关闭输出 |

POS_VEL 的 HOLD 是上线前置条件，包含显式 HOLD 和 watchdog HOLD。失联锁存的保持/关闭策略、vel=0、方向与单位都须单独验收，不能沿用界面“500 ms 后 DISABLE”的文字作实现证据。不得将 `kp=kd=0` 当作 POS_VEL 的输出关闭，也不得在失联时自动切回 MIT。实际驱动不是 MIT 时，V1 的 RETURN 与其他非 DISABLE 命令不予准入；依据是读回确认的模式，不是命令自报的模式。若无法验证 HOLD、失联锁存与明确 DISABLE 效果，整项 POS_VEL 能力不开放；不能通过隐藏 HOLD 按钮绕过固件停止验证。

## 4. 协议兼容策略

### 4.1 保留 V1，新增明确的 V2 入口

| 层 | 保留 | 新增（名称为提案） |
| --- | --- | --- |
| WebSocket | `joint_command` / `joint_command_ack`，只表示旧 MIT；`mode=3` 继续全局 DISABLE | `motor_capabilities`、`motor_set_control_mode`、`motor_control_lease`（申请/释放）、`motor_command_v2` 和对应状态事件 |
| ROS | `/stm32/joint_commands` 上的 `microros_stm32h723_bridge/msg/JointCommand` 布局冻结；`HardwareStatus` 布局保留 | 同包内的 `JointCommandV2`、`/stm32/joint_commands_v2`、模式配置服务与 `MotorControlStatus` |
| 固件 | 旧 MIT 与 DISABLE 的解码和处理 | 驱动适配、配置代次、V1/V2 命令仲裁、实际模式与切换错误反馈 |

新 WS op 在旧 Bridge 上应明确返回未知操作，绝不改写为旧 `joint_command` 重试。V1 类型与布局保持冻结：`header`、`sequence`、`mode`（0=HOLD，1=TRACK，2=RETURN，3=DISABLE）以及 `float32[7]` 的 `position`、`velocity`、`kp`、`kd`、`effort`。不追加 `drive_mode` 或 POS_VEL 字段；原地追加会改变 ROS 2 CDR 与类型哈希。V2 IDL 放在现有 `microros_stm32h723_bridge`，MCU 静态库与 Jetson typesupport 一起生成，实现前先估算 micro-ROS 内存。旧 overlay 缺少 V2 typesupport 时，Bridge 应可构建 MIT-only 版本并报告 V2 不可用，不能仅因客户端是新版就宣称支持。`MicroRosSystem`、Teleop、JTC 与示教不得订阅 V2。

新 Bridge 对旧 `joint_command` 中意外携带的驱动模式字段主动报错，避免调用者误以为被采用。V1 标量位置、缺省 mask=joint1、共享数值字段和 ACK 继续兼容；V1 不接受 POS_VEL 语义。

### 4.2 能力发现必须来自正在运行的固件

`hello` 只声明 Bridge 是否懂 V2；随后查询 `motor_capabilities` 获得当前固件/电机证据。不能仅用 Bridge build ID、Topic 订阅者数量或 ROS 消息类型判断 POS_VEL 可用。

响应至少包含：

- 协议版本、固件 build/version、启动会话 `boot_id`、配置代次 `control_epoch`、状态源时间及 Bridge 单调接收龄。
- 每轴稳定索引、型号/映射标识、可用驱动模式、**实测/已读回的当前模式**、enable 状态与切换阶段；未知与已验证必须区分。
- 可用执行状态、位置/速度单位及已验证约束、HOLD 策略版本、停止能力、模式配置是否需要现场参数准备。
- 当前命令源归属、配置中/忙碌/故障原因；POS_VEL 掩码只包含已完成验收且可用的轴。

Bridge、Rust 和 UI 都按连接身份/代次隔离该状态；重连、MCU 重启、能力过期、模式配置变化后撤销旧授权。控制准入需读取新鲜状态，而不是只相信连接时 hello。`control_epoch` 配合 `boot_id` 防止 MCU 重启后序列或配置代次重用。

### 4.3 V2 控制示例

以下仅表示未来协议形状，不是当前可用命令。协议与 ROS IDL 冻结时须补齐字段类型、长度和错误码测试。

```json
{
  "op": "motor_command_v2",
  "request_id": "example-uuid",
  "boot_id": "example-firmware-boot",
  "control_epoch": 12,
  "source_id": "example-bridge-session",
  "lease_id": "example-firmware-grant",
  "control_mode": "POS_VEL",
  "mode": 1,
  "active_joint_mask": 5,
  "position": [0.1, 0, 0.2, 0, 0, 0, 0],
  "pos_vel": { "velocity_limit": [0.1, 0, 0.1, 0, 0, 0, 0] },
  "confirmation": "ARMED"
}
```

这里 `active_joint_mask` 是 V2 的命令选择掩码，不是硬件可用掩码或已使能状态。V2 未选轴保持失能且不发送运动帧，不能仅填 position=0 / velocity_limit=0；所选集合在任务内固定，改集合需先全局 DISABLE 并重新准入。未选轴的驱动寄存器不自动改变，反馈仍逐轴报告。V1 维持既有“清零参数”行为，不声称其未选轴已经失能。

数组严格匹配能力声明的关节数量，首版 ROS 固定 7 轴；拒绝缺项、超长、未知位、未选轴非零值，以及 mask 不完全受设备能力覆盖的请求。UI 可提供“统一速度上限”填写多个轴，但线上始终明确逐轴数值。示例数值仅说明格式，不是现场默认或推荐速度。

`JointCommandV2` 对应携带 boot/config/source/lease 身份、sequence、执行状态、控制掩码及固定长参数数组。帧上的 `control_mode` 只是声明，准入不看它，只看固件读回确认的实际模式。声明与已确认模式不一致时拒绝该帧：保持当前输出策略，不改寄存器，不静默降级，不照样执行，也不把该帧当成切换请求。已确认 MIT 的周期命令只走 V1；已确认 POS_VEL 的周期命令只走 V2 POS_VEL。不存在把 V2 帧声明成 MIT 来驱动的第二条通路。同一条周期流不得交替两种编码。POS_VEL 帧上非零 `kp` / `kd` / `effort` 是错误。Bridge 统一分配 V1/V2 sequence，并按新鲜硬件反馈同步，不能各建一个计数器；固件对所有来源统一进行序列、代次和归属校验。

发布成功或 ACK 只代表 ROS 已发布，含所发布帧的协议、自报模式、代次及 sequence。自报模式没有被准入采用。它不代表驱动切换成功、固件已执行、目标已到达或机械静止。切换是否成功只看逐轴 CTRL_MODE（RID=10）读回。`MotorControlStatus` 报告已接受或拒绝的序列、错误、已确认的当前驱动模式与配置状态；拒绝同时写到旧客户端能看见的状态或故障通道，不能只留在 V2 日志。原 `HardwareStatus` 继续供旧程序读取执行状态、故障和序列。模式确认不能只看旧 HardwareStatus 的 TRACK，也不能看界面下拉或“已请求切换”。

### 4.4 V1 / V2 仲裁及降级

| 客户端 / Bridge / 固件组合 | 行为 |
| --- | --- |
| 旧 Desk + 旧 Bridge + 旧固件 | MIT 按当前行为运行 |
| 新 Desk + 旧 Bridge（无能力声明） | 默认旧 MIT；POS_VEL 禁用并解释缺少 Bridge 支持；V2 请求不降级 |
| 新 Desk + 新 Bridge + 旧固件或旧 ROS overlay | MIT 可用；POS_VEL 不可用，指出缺少固件/接口能力 |
| 旧 Desk/Bridge + 新固件，实际处于 MIT 且无 V2 占用 | 原 MIT 请求兼容 |
| 任一旧发布者 + 新固件，实际非 MIT、正在切换、各轴不一致或 V2 占用 | 运动命令拒绝。V1 `/stm32/joint_commands` 除 `mode=3` 外拒绝，避免 JTC 把 MIT 增益送进位置环；不改寄存器、不抢占 |
| 周期帧或 V2 `control_mode` 与读回确认模式不一致 | 拒绝执行，保持当前输出策略；不改寄存器，不降级，不照样执行，不把该帧当切换。唯一仍接受的是 V1 `mode=3` |
| 全链 V2、所选轴能力完整、寄存器读回已确认 POS_VEL | 只接受 V2 POS_VEL 周期帧，并通过全部既有与新增安全门；帧内自报模式不算确认 |
| 新固件所选轴驱动模式未知、不一致、反馈过期或部分切换失败 | 拒绝运动命令，保留占用与诊断；只接受停止，即 V1 `mode=3` |
| 断线/重启/回退软件后仍残留 POS_VEL | 不恢复旧目标、不按 MIT 猜测；先完成新鲜停止证明，再显式恢复 MIT 配置 |

同一 V2 任务的所选轴必须是统一且已验证的驱动模式；未选轴在已证明失能时可保留不同寄存器配置，不因全机配置不同而误拒该任务。周期帧内不得混用 MIT 与 POS_VEL。放行旧 ros2_control 栈之前，整组必须确认回到 MIT，并且 V2 lease 已释放；此前不启动 Teleop、JTC 或示教。

V1/V2 在 MCU 同一准入点仲裁，规则以「房间共识（2026-11-17）」的准入条款为准：只认读回确认的实际模式，不认命令自报的 `control_mode`。`lease`、`boot_id`、`control_epoch` 在该准入点校验。仅在桌面隐藏按钮或停止本进程发布者不能防止其他 ROS 发布者竞争。切换进行中或各轴不一致时拒绝运动，只接受 V1 `mode=3`。该 DISABLE 在任何驱动模式下都要能停下输出。禁止把 POS_VEL 静默降级为 MIT，也禁止把不匹配帧照样执行。拒绝必须写到现有状态或故障通道，Desk 能显示；只写日志不算完成。

## 5. 模式切换与停止

### 5.1 受控配置事务

若当前 Motor 流仍运行，用户先停止并等待原任务完成新鲜 DISABLE 确认及恢复记录收尾；其他控制栈须先完成既有停止退出。配置任务不抢占一个仍在运行或停止结果未知的任务。

UI 下拉框只选择候选模式；点击“应用驱动模式”才发起原生配置任务。任务与 Motor 连续流、Motion、Controller 启停、示教、标定等共享控制占用，双击、跨窗口请求及迟到 ACK 不能并发切换。

```text
选择候选模式（仅编辑，不是成功）
    → 用户确认现场支撑及本次切换
    → 原任务已停止并收尾，原生原子取得配置任务占用
    → 再次请求 DISABLE（覆盖准入前后的状态变化）
    → 新鲜反馈证明输出关闭
    → 固件原子校验仍失能并取得配置独占，拒绝竞争控制
    → 固件写入达妙 CTRL_MODE（RID=10）；这是寄存器事务，不是周期帧字段
    → 逐轴读回必须等于目标；状态只上报已确认模式
    → 读回失败：保持失能，报告逐轴实际模式，不进入 TRACK
    → 全部读回成功后才发布新的 control_epoch，才允许该模式的周期命令
    → 重新确认参数与安全授权
    → 点击开始，首帧准入成功后按 20 Hz 发送
```

发布成功、ACK、下拉选择或“已请求切换”都不是切换成功。只有逐轴寄存器读回与目标一致才算成功。读回完成前不接受该模式的周期命令，周期流中也不接受 MIT 与 POS_VEL 交替帧。

模式确认后清空旧命令缓存，使用新鲜实测位置准备经过验证的中性首帧；保持失能直到用户显式开始。使能到首帧期间不得短暂执行旧缓存目标，不能用“目标模式已经正确”跳过此检查。

固件取得配置独占时须再次验证实际失能及停止证明代次；证明后若有其他来源重新使能，则拒绝配置，不在运动中改寄存器。

配置操作采用幂等 request ID 和预期 boot/epoch。受理或发布只表示事务已提交；完成只看逐轴 CTRL_MODE 读回。超时表示结果未知，不能自动重发一项可能仍在执行的配置，也不能释放控制占用。已运行的其他控制栈不由 Motor 页强杀；需先走既有停止并退出流程并核验无竞争发布者，固件仲裁仍作为最终防线。

切换中任一轴失败：停止后续使能/控制，保持全组输出关闭，报告逐轴实际模式及失败阶段。只有确认全组恢复 MIT 才标记“回退完成”；不可假设批量配置原子成功。切换可取消，但取消以停止/读回结果确认结束。中途用户 DISABLE 必须使该事务失去之后使能或自动开始的权限。

已有 `damiao_ensure_control_mode` 会预加载命令，读取位置失败时可回退为零，忽略部分 CAN send 结果，并包含阻塞等待；它不发送 enable，但也不验证调用前已 DISABLE，**不能原样用于在线切换**。须把失能态写入和逐轴读回从 250 Hz 环拆出，对每步限时并检查发送结果，禁止用零值代替缺失反馈。若具体电机只能在使能状态切换，该型号不支持 v1 在线切换。不得为了复用 helper 弱化此边界。失能态能否改寄存器仍待台架；设计先按“必须先失能再写 RID=10”执行，台架若证明做不到，就不开放在线切换。

### 5.2 命令源许可

`motor_control_lease` 的申请/释放也必须通过原生任务和固件仲裁，不能成为绕过控制锁的新入口。Bridge 为连接生成 `source_id`；固件在配置任务准入时确认配置独占，完成后仍不产生运动许可。用户显式开始时，固件以新鲜 boot/epoch、实际模式、故障及失能状态为条件签发一次 `lease_id`，与 source、所选轴和模式绑定；每个 V2 控制帧都必须匹配。该身份用于仲裁和重放防护，不替代现有 SSH/本机 DDS 信任边界。

运动许可由有效运动帧续期，普通查询不续期；100/500 ms 策略仍由 MCU 单调时钟决定。DISABLE、故障、boot/epoch 变化或超时撤销许可，排队旧帧即使 sequence 更大也不能重新使能。用户重新开始需要新许可及安全确认。配置独占和运动许可分开：DISABLE 撤销运动许可，同时让在途配置停止推进；原生继续持有结果未知的任务，不能因许可失效就宣称配置已结束。

放行旧 MIT 控制栈前，整组必须确认回到 MIT，配置/运动任务已结束，并且 V2 lease 已释放。此前不启动 Teleop、JTC 或示教。POS_VEL 断流不能让遗留 V1 发布者立即接管。新旧序列比较须沿用统一 uint32 回绕规则，并用 boot/epoch/lease 排除别的来源；验证跨回绕、迟到 ACK 与重启重复序列。这些身份在固件准入点执行，不能只靠隐藏 Desk 按钮。

### 5.3 停止、watchdog 与恢复

- 现有 `joint_command mode=3` 与 `safe_stop` 的停机义务保持高优先级。Bridge 对 `mode=3` 归零所有通道并分配三帧新 sequence；新模式配置失败、能力缺失或错误都不能阻塞该路径。任何驱动模式下都要能停机。非 MIT 时 V1 不接受 RETURN，停机落到输出关闭，而不是把 MIT 增益送进位置环。新固件必须能按各轴实际模式（未知时使用已验证的全模式禁用策略）停机。拟在新固件中把零输出 DISABLE 作为 fault 11 锁存下仍可受理的幂等停止动作，保持锁存与禁止重新使能，不能用它软恢复。这是新固件行为。旧固件在 fault 11 锁存后拒绝新命令，包括 DISABLE，没有不清锁的幂等 DISABLE。
- 保留既有 TRACK 100 ms 转 HOLD / 非 DISABLE 500 ms 指令丢失锁存边界；新驱动需验证保持与停止策略。500 ms 锁存并不等于输出关闭，不自动清锁、不自动恢复流。桌面仍是 20 Hz 发送，绝不把 POS_VEL 改成“一次下发目标后无限保持”。模式配置应有独立超时，在输出关闭状态执行，不靠伪造运动 heartbeat 延续任务。
- Rust 当前 250 ms 指令流检查、至少 1 秒停止重试、所属窗口/原机器人绑定和反馈证明继续保留；普通能力/状态查询不能续运动租约。新增 V2 的实际 transport 写入必须更新同一流记录。
- POS_VEL 反馈过期、CAN 失败或保持无法保证时，采用经过验证的故障关闭策略，不向旧目标继续运动、不自动切 MIT、不清除锁存故障。
- DISABLE 发布 ACK 不释放任务。继续等待匹配连接、启动/配置身份、新序列和推进的源时间戳；明确“输出已关闭”不等于“机械臂静止”。
- DISABLE 必须撤销运动许可及排队运动帧，但保留配置/停止核验任务占用直到收尾。
- 新模式配置也需纳入桌面重启恢复记录。记录只存身份、任务类型/阶段与核验所需元数据，不保存可自动重放的目标、速度或授权。重启后保留占用，用户连接原机器人后仅请求停止与状态核验，绝不重放配置或自动恢复运动。

## 6. Motor 页交互优化（2026-11-17 截图反馈）

本节补充应用侧交互方案，不改变三仓已确认的周期控制、停止证明和驱动模式切换契约；本 PR 仍不实现页面或控制代码。

### 6.1 两点建议的判断

| 截图中的建议 | 判断 | 首版交互决定 |
| --- | --- | --- |
| 增加 MIT / POS_VEL 模式切换按钮 | 合理。现有“MIT 命令模式”实际选择的是 HOLD / TRACK / RETURN，不能用同一个下拉框混入驱动模式 | 独立 `MIT / POS_VEL` 分段选择和“应用驱动模式…”按钮；原下拉改名“执行状态”。选择仅编辑候选，实际模式须由固件读回确认 |
| POS_VEL 应该不用周期发送 | 作为“用户只点击一次执行目标”的操作预期合理；作为“链路只发一帧”的实现结论不成立 | 主按钮改为“执行目标并保持”，不要求用户反复点击。后台继续当前 20 Hz 指令流、固件周期输出及 watchdog；不新增单包发送模式 |

区分三个层次：

1. **用户操作**：选择关节、填写目标位置和速度上限，点击一次“执行目标并保持”。开始后使用固定参数快照，不由表单输入实时改写目标。
2. **桌面 → Bridge → MCU**：本方案首版继续按 20 Hz 发送当前获准的 V2 指令，每帧分配新 sequence 并校验有效 lease；不是反复发起模式切换或重建运动任务。保留现有 WebView 指令来源和 Rust 对实际写入的监督，不借本次 UI 优化改成 Rust 自动重放/续发运动。
3. **MCU → 电机**：固件的周期调度与桌面操作解耦。现有共识按 250 Hz 输出环设计，POS_VEL 具体接入及效果仍需台架验收。不能由“电机内部有位置环”推出上游可以停止续发，或把 20 Hz 和 250 Hz 当成同一个开关。

停止上游周期指令会触发已有 TRACK 100 ms 转 HOLD、非 DISABLE 500 ms 指令丢失锁存策略。POS_VEL 不因有内部位置环而豁免；“一次提交目标，由下游自行执行并保持，单独心跳续租”是另一种未来协议，需另行设计目标生命周期、心跳、取消和停止证明，**不在本次首版方案内**。

“执行目标并保持”表示持续控制，不能显示成“单次发送”或在发布 ACK 后显示“已到位/任务完成”。到位也不自动关闭输出、不释放占用或恢复其他控制栈。首版状态使用“已发布 / 持续控制中 / 停止确认中”；如后续新增到位提示，必须以新鲜逐轴反馈、目标误差与停稳判据为依据，并明确仍在保持。停止或离开页面沿用 DISABLE 流程，不为了保持姿态让隐藏页面继续控制。

### 6.2 界面分区与文案

保留截图的“左侧关节目标、右侧操作区”，减少顶部重复提示。右侧标题从“共享 MIT 参数”改为“电机控制”，内容依次为驱动模式、执行状态、当前模式参数、安全确认和执行/停止。

```text
Motor Control                              已选 2 轴 / 可用 6 轴
实际驱动：MIT（已读回）    固件状态：DISABLE    fault 0

左侧：关节目标                              右侧：电机控制
[使用当前位置]                             驱动模式 [MIT | POS_VEL]
关节     实测位置    目标位置                 待应用：POS_VEL
[x] j1      …       [滑块 / 数值]            [应用驱动模式…]
[x] j3      …       [滑块 / 数值]            执行状态 [TRACK | HOLD]

POS_VEL 候选参数                            安全确认 [ ]
关节     速度上限 rad/s                      [执行目标并保持]（待模式确认）
j1          [输入]                          [停止并 DISABLE]
j3          [输入]
[统一填写所选轴速度上限]                     状态：模式未应用
                                           ▸ 控制详情
```

- **模式选择**：使用显式文字分段按钮，不用图标或一个含义不清的开关。选择 POS_VEL 可以预览其参数，但标记“待应用”；实际模式仍显示 MIT。当前硬件无能力时显示不可选及具体原因，不能只隐藏问题。申请中、部分失败、未知模式都有独立状态。
- **应用模式**：仅在原控制任务已停止并收尾后可用；点击先显示所选关节、当前 → 目标模式和现场支撑确认，再执行 §5 事务。读回未成功时禁止开始。不同候选撤销旧安全授权；成功切换不自动执行目标。
- **执行状态**：MIT 保留 HOLD / TRACK / RETURN；POS_VEL 首版仅 TRACK / HOLD。DISABLE 作为常驻独立停止动作，不与目标参数填写混在一起；移出下拉不改变底层 `mode=3`。选择执行状态不切换驱动寄存器。
- **参数**：MIT 显示共享 Velocity / Kp / Kd / Effort；POS_VEL 显示逐轴“速度上限 · rad/s”，位置仍逐轴编辑；提供批量填写便利，但线上数值仍明确逐轴。两套草稿分离，不把 MIT 的速度复制成速度上限，不隐藏后继续发送 Kp/Kd/Effort。输入值与命令仍遵守 §3 校验。
- **主动作**：MIT TRACK/RETURN 为“开始控制”，POS_VEL TRACK 为“执行目标并保持”，HOLD 为“保持当前位置”。都只在一次点击后启动当前方案的持续指令流。运行中按钮显示“持续控制中”并禁用，驱动候选、执行状态、掩码和参数锁定；首版修改目标须先停止、确认输出关闭，再重新开始。
- **停止**：两种驱动模式共用“停止并 DISABLE”，不要求安全确认已勾选，不依赖参数合法或能力探测成功。显示“停止确认中”，直到匹配的新鲜反馈证明输出关闭；通信不可用时说明停止未确认，不能把按钮点击或 ACK 显示为关闭成功。界面提供请求入口，不承诺物理机械臂立即停稳。
- **授权**：使用“已核对所选关节、参数及现场安全”；驱动候选/模式、执行状态、所选轴或目标参数变化后撤销旧确认。停止后重新开始须重新安全确认：POS_VEL V2 申请新 lease，MIT V1 沿用原生任务准入，不要求旧协议携带 V2 lease；不因保留表单值恢复发送。
- **状态与详情**：常驻实际驱动、执行状态、故障、持续控制/停止状态；“20 Hz 指令流、sequence、lease、反馈龄、Topic”移到折叠详情。关节复选框及计数改称“选择控制 / 已选”，`active_joint_mask` 显示为“固件可用轴”，避免把 UI 选择、固件能力与实际电机使能混为一谈。
- **提示**：截图里的“停止发送后 500 ms DISABLE”不能继续沿用。拟用“停止或离开页面会请求关闭输出，结果以新鲜固件反馈为准”；故障 11 锁存行为及未知停止结果在相关状态下明确显示，不能暗示原固件已支持新增停止行为。

### 6.3 布局与交互验收

宽屏保留两栏，操作区随内容滚动保持可见；窄屏改为单栏，驱动模式、实际状态、执行/停止优先展示，关节目标紧随其后。停止入口始终易于到达，不被确认弹层、长故障文字或关节列表遮挡；关键状态不只靠颜色表达，所有按钮和模式选择支持键盘。

设计/实现验收至少覆盖：

- 候选 POS_VEL、实际 MIT 时只能预览参数，不能执行；读回失败或能力不支持不能伪装成切换成功。
- MIT / POS_VEL / HOLD 的按钮与参数正确切换，授权失效，不在点击分段按钮时发送控制指令。
- POS_VEL 点击一次后持续控制，诊断中仍可见 20 Hz；到位/ACK 不结束任务，反复点击不会产生并行流，停止后迟到帧不能重新使能。
- MIT 老协议、未选轴语义、固件准入、页面隐藏、断线/重连、源窗口退出与原生恢复机制均按既有方案回归。
- 正常及窄窗口、长错误消息、停止确认中、部分轴失败等布局；生产实现执行 `npm test` 全量、`npm run build` 与实际视觉验证。

## 7. 跨仓实施顺序

| 阶段 | 仓库与改动 | 完成条件 |
| --- | --- | --- |
| A：冻结契约 | executor + ROS 栈在现有 `microros_stm32h723_bridge` 中定义 V2 IDL、能力、单位、执行状态、错误、仲裁及切换事务；实现前估算 micro-ROS 内存 | 同一规范和 golden fixtures；V1 话题与布局不变；不追加 `drive_mode`；HOLD / vel=0 / 失能改寄存器仍以台架为准 |
| B：固件 | `motor_bridge.*` 驱动适配、POS_VEL 验证/编码、CTRL_MODE（RID=10）失能态写入与逐轴读回、状态、watchdog；重建 micro-ROS 库。不把 `damiao_ensure_control_mode` 原样放进在线切换 | 无硬件单元测试及隔离台架验证；旧 MIT 回归通过；未验收轴不报可用；fault 11 下不清锁的幂等 DISABLE 按新行为单测，不宣称旧固件已有 |
| C：ROS 栈 | 安装新消息/服务类型；`MicroRosSystem`、Teleop、JTC、示教继续只订阅 V1；旧栈启动/写入前确认整组 MIT 且 V2 lease 已释放 | 这些路径不得订阅 V2；切换竞争与停止可测；非 MIT 时 V1 非 DISABLE 被拒 |
| D：Bridge / Rust | Bridge 增加能力与 V2 操作；Rust 把新 op 纳入准入、优先级、停止、占用、配置恢复及身份隔离 | 新旧组合和直接 IPC/WS 绕过 UI 的负例测试通过 |
| E：桌面 | `src/motorLogic.ts` / `MotorControl.tsx` / `types.ts` / `bridge.ts` 的类型、表单和能力提示 | MIT 行为回归，POS_VEL 状态与草稿分离，窄屏及跨窗口验证 |
| F：部署验收 | 按固件、ROS typesupport、Bridge、桌面兼容矩阵分阶段升级 | 每层实际运行版本可核验；模式切换与回退都有证据；现场确认后才开放能力 |

Bridge 更改集中在 `bridge_core.hpp` / `bridge_node.cpp` 及新独立电机逻辑模块。Rust 至少审核 `session/tasks.rs`、`motor_task.rs`、`motor_recovery.rs`、`transport.rs`、`runtime.rs`、`session/command_queue.rs` 及任务状态/恢复文档；Bridge 的全局启动互斥也须覆盖新 op。建议提取统一命令分类，当前多处按 op 名 `joint_command` 识别运动，遗漏会造成 V2 不计入控制锁或 watchdog。模式配置不得经任意 WebView shell/SSH 或绕过原生任务系统。

实际实现时再同步 `docs/protocol.md`、`docs/basic-features.md` 和 `docs/architecture.md`；本次不把待实现能力写入现有功能清单。Bridge 包有变化时生成 build ID，使用既有 deploy 脚本构建/核验/重启；不得把构建成功视为当前进程已更新。

### 回退

先停止并确认输出关闭，再由仍支持 V2 的工具确认整组恢复 MIT、无切换事务、V2 lease 已释放，最后回退软件或固件。新版固件重启不能盲目假定电机寄存器恢复 MIT。仅回退桌面不改变实际驱动模式；如果已失去模式读回能力，应保持停止并通过受控维护恢复，不能让旧客户端试发 MIT 探路。确认回到 MIT 之前不启动 Teleop、JTC 或示教。

## 8. 验证与验收矩阵

| 范围 | 必须覆盖的成功与失败边界 |
| --- | --- |
| 纯逻辑/UI | MIT 原有数值行为；POS_VEL 速度未填/负/零/NaN/Infinity/float32 溢出；能力缺失；模式草稿互不污染；参数块错配；部分关节不支持；模式切换撤销授权；窄屏停止入口 |
| Bridge | V1 payload/ACK 回归；未知 V2 op 无降级；旧 overlay 可构建；ROS 数组长度、mask、未选轴非零、订阅者、反馈新鲜度、序列同步；旧 boot/epoch 拒绝 |
| 固件 | POS_VEL 字节编码及 CAN ID；真实模式读回；禁用状态切换；使能首帧目标无跳变；HOLD 锁存；100/500 ms watchdog 与保持/锁存；fault 11 下幂等 DISABLE 不清锁；故障处理；批量部分失败；全模式 DISABLE；V1/V2 竞争、lease 撤销、DISABLE 后迟到帧及序列回绕/重放；错模式帧被拒且输出策略与寄存器不变；拒绝出现在状态/故障通道而不只在日志 |
| Rust/跨窗口 | V2 首帧与配置任务登记；竞争模式/控制器操作；窗口退出、页面隐藏、流中断、ACK 丢失；旧响应不恢复任务；直接 IPC 请求仍受门禁；DISABLE 优先；恢复文件损坏/落盘失败保持占用 |
| ROS 集成 | 新/旧 Bridge 与固件模拟器组合；V1 发布者在 POS_VEL 下被拒；V1 DISABLE 仍可停止；MCU 重启、类型缺失、服务超时和状态乱序；MIT ros2_control 不误在 POS_VEL 上启动 |
| 台架/现场 | 按实际型号验证速度符号/零值、限位、方向/单位、加减速、首帧、保持、断流、断线、掉电重启、停止与模式回读；确认每轴有界响应，不能以“已发布”验收 |

实现 PR 按仓库要求执行根目录 `npm test` 全量测试；涉及 TypeScript/React 后再 `npm run build`；文档执行 `npm run docs:build`。ROS 环境执行 `colcon build`、`colcon test` 及隔离 Topic/ROS_DOMAIN_ID 验证；若只能 CTest，必须记录限制。台架测试先使用模拟器、隔离轴与现场支撑确认，不用生产机械臂验证一般代码修改。

本 Draft 只做源码核对和文档构建，不声称通过功能测试、ROS 集成或硬件验收。

## 9. 方案取舍及待决项

| 选项 | 取舍 |
| --- | --- |
| 在旧 `mode` 增加 POS_VEL=4 | 不采用：将状态与驱动混为一体，既有停止/任务判定会误读 |
| 在旧 `JointCommand` 末尾追加 `uint8 drive_mode` | **否决**（2026-11-17，三仓一致）：改变 ROS 2 CDR / 类型哈希，未重编译节点无法互通；旧 Bridge 可能忽略新 JSON 字段仍按 MIT 发布。改为独立 V2 |
| 只给旧 JSON 加 `control_mode` | 不采用：旧 Bridge 可能忽略它后仍按 MIT 发布 |
| 原地增加旧 ROS msg 字段 | 不采用：与上一行同一类风险，V1 布局冻结 |
| 新 V2 入口、旧 MIT 保留、固件统一仲裁 | 推荐，且为三仓共识：增加接口与测试成本，但版本不支持时可明确拒绝，既有 MIT 可继续使用 |
| 在 ros2_control 中一次迁移所有控制模式 | 延后：POS_VEL 不接收现有重力前馈力矩和逐帧 MIT 增益，不能视为透明替换；轨迹跟踪和停止策略需另行设计 |

下列各项里，范围已经同意，台架结果还没有。未完成台架不阻碍评审本文，但会阻止宣称 POS_VEL 可运行，也不能把它们写成已解决：

1. 仍待台架：现场每轴电机型号/固件、失能时能否改写模式寄存器、POS_VEL 速度零值的保持语义、方向与单位、HOLD 与 watchdog。读回失败时的行为按房间共识执行，不把“设计要求读回”写成“台架已经证明寄存器可写”。
2. 已同意的首版范围：POS_VEL 不提供 RETURN；joint7 等待单独验收，运行时仍以逐轴能力为准。同一任务使用单一驱动模式，不在周期流中混用 MIT 与 POS_VEL。
3. 实现前必须估算、但本文尚未给出数字：micro-ROS 服务/状态资源预算、V2 固定 IDL、启动身份与配置代次生成规则、原子命令源仲裁和故障码映射。不得用 UI 约定代替固件校验。
4. 已同意：旧控制栈留在 V1 MIT。放行 Teleop / JTC / 示教之前，整组回到 MIT 且 V2 lease 已释放。扩大范围时另补控制与停止验收。fault 11 锁存下不清锁的幂等 DISABLE 是新固件行为，旧固件没有。
