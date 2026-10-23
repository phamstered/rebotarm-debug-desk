# 重力辨识 UI

适用于 **Rebotarm Debug Desk**（仓库 [`phamstered/rebotarm-debug-desk`](https://github.com/phamstered/rebotarm-debug-desk)）。

> **状态：实现中（Desk Bridge + UI 已落地；对齐 stack [#23](https://github.com/phamstered/rebotarm-ros2-stack/pull/23) IDL + [#24](https://github.com/phamstered/rebotarm-ros2-stack/pull/24) FULL_ARM 编排）。**  
> Desk 调用 `/StartGravityID`；**FULL_ARM** 由 `gravity_identification_node` 执行（12 姿态、TRACK@v≈0 + Pinocchio 前馈、abort→HOLD、YAML + GC hot-reload）。  
> **PAYLOAD_SUBMODE**：stack #24 v1 **拒绝**（用现有 Joint4 / `joint4_calibration_controller`）；Desk UI 禁用 Start 并链到 Joint4。  
> Jetson：合并 stack main+#24 后重建 Bridge（需 action IDL）。推荐 bring-up：`state_only:=true` + `gravity_identification.launch.py`。  
> `docs/basic-features.md` 仍不标完整「已实现」直至 Jetson 实机 E2E；当前为 **Bridge/UI ready + stack FULL_ARM orchestrator in #24**。


## 1. 产品定位

| 项 | 约定 |
|---|---|
| 页面名 | **重力辨识**（Navigation 独立页） |
| 与 Joint4 | **分离**：本页默认全臂重力 ID；[Joint4 标定](./joint4-calibration) 作为 **PAYLOAD_SUBMODE** 入口（链到现有 Calibration 页，不复用 Begin/Capture/Fit Trigger UI） |
| Desk 职责 | **仅 UI + Bridge**：组 Goal、展示 Feedback/Result、Cancel；不跑辨识算法、不写固件协议 |
| 编排 | [`rebotarm-ros2-stack`](https://github.com/phamstered/rebotarm-ros2-stack) action 服务器（#23 接口冻结；orchestrator 可能仍 WIP） |
| 固件 | [`rebotarm-executor`](https://github.com/phamstered/rebotarm-executor)：meas + HOLD/TRACK；abort / **命令丢失** → **HOLD**（非 DISABLE）；静置前馈用 **TRACK @ v≈0**（现网 HOLD 清零 MIT effort） |

不要与日常 `gravity_compensation_controller` 或手工 `joint4_calibration_controller` 同时抢 effort 接口；互斥切换由 **stack 编排**完成，Desk 只显示就绪/阻塞原因。

<GravityIdentificationFlow />

## 2. UI 线框

下列组件为 VitePress HTML 线框，字段名与 stack Feedback/Result 对齐；React 页面 `GravityIdentificationPage` 已按同字段绑定。

<GravityIdentificationWireframe />

### 2.1 布局区块

1. **Goal**
   - `joint_mask`：J1–J6 复选框（bit0=joint1 …；默认全选 / `0x3F`；全不选时 Bridge 按 `0x3F`）
   - `mode`：`FULL_ARM_GRAVITY`（0，默认，可 Start） / `PAYLOAD_SUBMODE`（1，**Desk 禁用 Start**；stack #24 拒绝，链到 Joint4）
   - `settle_time_s` / `capture_window_s`、`write_yaml` / `hot_reload`、`output_yaml_path`
   - `max_effort_nm` / `max_velocity_rad_s` / `command_timeout_ms` / `lock_gripper`
   - **`command_timeout_ms`**：仅对齐 **host / 编排侧**期望；**不会**改变 MCU 编译期超时（约 **100 ms** 无命令 → HOLD，约 **500 ms** → fault **11**）。UI 旁注已标明。
   - 默认 `max_effort_nm=10`（与 stack #24 Goal 示例一致；硬限仍 |effort|≤10）
   - FULL_ARM：编排器内置 **12** 姿态；j1–3 / j4–6 分幅值；Desk 不规划姿态
2. **安全与控制**
   - 安全确认 → 与 Motor 一致的 **`confirmation: "ARMED"`** 门
   - **Start** / **Abort**（Abort 在 running/canceling 始终可用）
   - 运行中锁定 Motor 滑块连续下发（紧急 DISABLE 仍可走 Motor mode=3）
3. **Feedback**
   - `phase`（0–10 中文标签）、`pose_index` / `pose_count`、`fault_code`、`message`
   - 实时 `residual_nm` / `measured_effort_nm` / `model_effort_nm` / `rmse_running`
4. **Result**
   - 表：`gravity_scales`、`torque_biases_nm`、每关节 RMSE
   - `rmse_total`、`yaml_path`、`success` / 结束 `fault_code`

### 2.2 与 Joint4 的关系（可选子模式）

```text
重力辨识（本页，默认 FULL_ARM）
    └─ PAYLOAD_SUBMODE ──链接──► Joint4 标定（现有页）
```

- 全臂一键 ID **不**复用 Joint4 的 Begin/Capture/Fit Trigger UI。
- **PAYLOAD**：stack #24 v1 在 action `handle_goal` 拒绝（文案含 `joint4_calibration_controller`）；Desk 同步禁用 Start + 链到 [Joint4 标定](./joint4-calibration)。
- 文档交叉链接：[Joint4 标定](./joint4-calibration) · 功能概览 [§6](./features#_6-joint4-标定) · [§8](./features#_8-重力辨识)。

## 3. Bridge / 协议（已实现）

WebSocket Bridge（`easy_debug_bridge`）已实现下列 op，并写入 [Bridge 协议](./protocol)。真实路径为 **rclcpp_action** 客户端 → `/StartGravityID`（**非** SSH `ros2 action` hack）。

Action 头经 `#if __has_include(<microros_stm32h723_bridge/action/gravity_identification.hpp>)` 门控：  
- Jetson 需先合并/安装 **stack #23** 的 msg/action 包后再编 Bridge，否则运行时返回明确错误（「action 未编译进 Bridge…」）。  
- 桌面 CI 只跑 `bridge_core` 单测（无 ROS）；不要求本机有 action IDL。

### 3.1 op

| op | 方向 | 作用 |
|---|---|---|
| `gravity_id_send_goal` | Desk → Bridge | 发送 Goal；**须** `confirmation: "ARMED"` |
| `gravity_id_cancel` | Desk → Bridge | Cancel goal / abort |
| `gravity_id_feedback` | Bridge → Desk | 推送 Feedback（节流 ≤10 Hz） |
| `gravity_id_result` | Bridge → Desk | 终态 Result |
| `gravity_id_status` | Bridge → Desk / 请求 | goal 句柄状态：idle / accepted / executing / canceling / … |

示例：

```json
{
  "op": "gravity_id_send_goal",
  "request_id": "uuid",
  "confirmation": "ARMED",
  "joint_mask": 63,
  "mode": 0,
  "settle_time_s": 1.5,
  "capture_window_s": 1.0,
  "write_yaml": true,
  "hot_reload": true,
  "output_yaml_path": "",
  "max_effort_nm": 10.0,
  "max_velocity_rad_s": 0.15,
  "command_timeout_ms": 100,
  "lock_gripper": true
}
```

```json
{
  "op": "gravity_id_feedback",
  "phase": 5,
  "pose_index": 3,
  "pose_count": 12,
  "active_joint_mask": 63,
  "residual_nm": [0.1, 0.2, 0.05, 0.3, 0.0, 0.0],
  "measured_effort_nm": [],
  "model_effort_nm": [],
  "rmse_running": 0.12,
  "fault_code": 0,
  "message": "capturing pose 3"
}
```

### 3.2 Action 字段摘要（权威在 stack#23）

**Goal：** `joint_mask`、`mode`（v1 仅 0=FULL_ARM；1=PAYLOAD 拒绝）、`pose_set_id[]`（#24 忽略并 WARN）、settle/capture、YAML + hot-reload、力矩/速度上限、`command_timeout_ms`、`lock_gripper`。默认 `joint_mask=0x3F`，`max_effort_nm=10`。

**Feedback：** `phase` 0–10、`pose_index`/`pose_count`、`active_joint_mask`、残差/力矩数组、`rmse_running`、`fault_code`、`message`。

**Result：** `success`、`fault_code`、`gravity_scales[]`、`torque_biases_nm[]`、`rmse_per_joint[]`、`rmse_total`、`yaml_path`、`message`。

**Safety：** abort / 超时 / **命令丢失（fault 11）** → **HOLD**（非 DISABLE）。静置采样若需重力前馈：host 用 **TRACK、velocity≈0、effort=前馈**（现网 HOLD 将 MIT effort 置 0）。

**`command_timeout_ms`：** Goal 字段传给编排侧，用于 **host 对齐**；MCU 侧仍为编译期约 **100 ms HOLD / 500 ms fault 11**，Desk/Bridge **不能**通过该字段改固件超时。

### 3.3 固件故障码（现网十进制）

Desk/Bridge 原样透传 `fault_code`，勿按位掩码解析。会话相关：

| 名 | 值 | 会话内建议 |
|---|---:|---|
| `FAULT_NONE` | 0 | 继续 |
| `FAULT_STALE_SEQUENCE` | **4** | abort |
| `FAULT_MOTOR` / DRIVE | **7** | abort → HOLD |
| `FAULT_CMD_LOSS` | **11** | abort → **HOLD**（非 DISABLE） |
| COMMAND_LIMIT（近义） | 3 | abort → HOLD |

### 3.4 辨识会话命令语义（现网，UI 文案已摘录）

| 阶段 | Host → 固件 | 说明 |
|---|---|---|
| 静置 / 采样（需前馈） | **`TRACK`，`velocity≈0`，`effort`=重力前馈** | HOLD 清零 MIT effort |
| 静置（无前馈） | `HOLD` | effort 通道为 0 |
| 换姿 | 短暂 `TRACK` | 到位后切回静置策略 |
| Abort / cancel / 命令丢失 | → **HOLD** | **不**自动 DISABLE |

须持续发送 JointCommand；约 100 ms 无命令 → HOLD，约 500 ms → fault 11。`|effort|≤10 Nm`；j1–3 DM4340P vs j4–6 DM4310，勿暗示同一激励适用于全部关节。

## 4. 安全（不得弱化）

1. **ARMED**：`gravity_id_send_goal` 缺 `confirmation: "ARMED"` 被 Bridge 拒绝。
2. **运行中锁定**：session running 时禁用 Motor 连续 JointCommand（除紧急 DISABLE）；TCP 拖拽互斥由后续加固（本 PR 先锁 Motor）。
3. **Abort**：UI → `gravity_id_cancel` → stack abort → 固件 **HOLD**。
4. **命令丢失**：fault **11** → ABORTING → **HOLD**。
5. **断开**：页面收到 `disconnected` 清空会话态；重新连接前应 Abort（编排侧负责最终 HOLD）。
6. **急停与现场**：操作者托住/急停就绪；Desk 不替代物理急停。

## 5. 仓库职责对照

| 仓库 | 做什么 | 不做什么 |
|---|---|---|
| **rebotarm-debug-desk** | 本页 UI + Bridge op + 单测 | 辨识算法、YAML 权威写入、固件超时策略 |
| **rebotarm-ros2-stack** | `/StartGravityID` 状态机、激励、拟合、热加载（#23 冻结接口） | 固件字节协议、Desk 布局 |
| **rebotarm-executor** | meas、HOLD/TRACK、command-loss → HOLD、十进制 fault | 姿态规划、最小二乘、写 YAML |

## 6. 落地检查清单

- [x] stack action 字段冻结（对照 [#23](https://github.com/phamstered/rebotarm-ros2-stack/pull/23)）
- [x] Bridge op + `bridge_core` 校验单测；`docs/protocol.md` 已同步
- [x] 前端页面 + ARMED 门 + Motor 运行中锁定
- [x] 固件约束与 `command_timeout_ms` host-only 说明出现在 UI
- [ ] Jetson：main+#24 后重建 Bridge（action IDL）并实机 E2E Feedback/Result
- [x] stack FULL_ARM orchestrator（[#24](https://github.com/phamstered/rebotarm-ros2-stack/pull/24)；Jetson 实机仍待）
- [ ] `docs/basic-features.md` 标完整「已实现」（**仅在 Jetson E2E 后**）
- [x] `npm test`（前端逻辑/页面；Bridge core 随 CI）

## 参考

- Stack IDL：[rebotarm-ros2-stack#23](https://github.com/phamstered/rebotarm-ros2-stack/pull/23) · FULL_ARM 编排 [#24](https://github.com/phamstered/rebotarm-ros2-stack/pull/24)
- 固件契约：[rebotarm-executor](https://github.com/phamstered/rebotarm-executor) · HOLD/TRACK / fault 11
- 现有手工标定：[Joint4 标定操作指南](./joint4-calibration)
- 协议：[Bridge 协议](./protocol)
- 功能概览：[功能概览 · 重力辨识](./features#_8-重力辨识)
