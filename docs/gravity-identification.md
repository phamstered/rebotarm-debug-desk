# 重力辨识 UI（设计草案）

适用于 **Robot Debug Desk**（仓库 [`phamstered/robot-debug-desk`](https://github.com/phamstered/robot-debug-desk)）。

> **状态：设计草案（未实现）。** 本文描述上位机如何呈现并调用 ROS action `/StartGravityID`（类型 `GravityIdentification`）。接口对齐 [rebotarm-ros2-stack#12](https://github.com/phamstered/rebotarm-ros2-stack/pull/12)。实现落地前不得写入 `docs/basic-features.md` 的「已实现」矩阵；Bridge `op` 名标注为 **proposed**。

## 1. 产品定位

| 项 | 约定 |
|---|---|
| 页面名 | **重力辨识**（独立 Navigation 页或 Calibration 下独立分区） |
| 与 Joint4 | **分离**：本页默认全臂重力 ID；[Joint4 标定](./joint4-calibration) 作为 **可选子模式 / 负载细标定** 入口（`mode=PAYLOAD` 时链到现有 Calibration 页或高级选项） |
| Desk 职责 | **仅 UI**：组 Goal、展示 Feedback/Result、Cancel、可选 Apply；不跑辨识算法、不写固件协议 |
| 编排 | [`rebotarm-ros2-stack`](https://github.com/phamstered/rebotarm-ros2-stack) action 服务器 |
| 固件 | [`rebotarm-executor`](https://github.com/phamstered/rebotarm-executor)（对齐 [PR #7](https://github.com/phamstered/rebotarm-executor/pull/7)）：meas + HOLD/TRACK；abort / **命令丢失** → **HOLD**（非 DISABLE）；静置前馈用 **TRACK @ v≈0**（现网 HOLD 清零 MIT effort） |

不要与日常 `gravity_compensation_controller` 或手工 `joint4_calibration_controller` 同时抢 effort 接口；互斥切换由 **stack 编排**完成，Desk 只显示就绪/阻塞原因。

<GravityIdentificationFlow />

## 2. UI 线框

下列组件为 VitePress HTML 线框，字段名与 stack Feedback/Result 对齐，便于日后 React 绑定。

<GravityIdentificationWireframe />

### 2.1 布局区块

1. **Goal**
   - `joint_mask`：J1–J6 复选框（bit0=joint1 …；全不选时 UI 提示将按 action 默认 `0x3F`，或禁止 Start）
   - `mode`：`FULL_ARM_GRAVITY`（默认） / `PAYLOAD_SUBMODE`（链到 Joint4 负载细标定说明）
   - `settle_time_s` / `capture_window_s`、`write_yaml` / `hot_reload`、`output_yaml_path`
   - `max_effort_nm` / `max_velocity_rad_s` / `command_timeout_ms` / `lock_gripper`
2. **安全与控制**
   - 安全确认 → 与 Motor 一致的 **`confirmation: "ARMED"`** 门（会话内一次即可）
   - **Start** / **Abort**（Abort 始终可用，对标 DISABLE 的「随时可停」）
   - **Apply to GravityCompensation**：Result 成功且 `yaml_path` 非空时启用（对应 Goal `hot_reload` 或事后 Trigger；实现时二选一，UI 文案写清）
3. **Feedback**
   - `phase`、`pose_index` / `pose_count`、`fault_code`、`message`
   - 实时 `residual_nm` / `measured_effort_nm` / `model_effort_nm` / `rmse_running`
4. **Result**
   - 表：`gravity_scales`、`torque_biases_nm`、每关节 RMSE
   - `rmse_total`、`yaml_path`、`success` / 结束 `fault_code`

### 2.2 与 Joint4 的关系（可选子模式）

```text
重力辨识（本页，默认 FULL_ARM）
    └─ 高级 / Payload 子模式 ──链接──► Joint4 标定操作指南（现有页）
```

- 全臂一键 ID **不**复用 Joint4 的 Begin/Capture/Fit Trigger UI。
- Payload 子模式若第一版仍走 `joint4_calibration_controller`，Desk 应跳转或嵌入现有 Calibration 流程，避免两套采样门互相覆盖。
- 文档交叉链接：[Joint4 标定](./joint4-calibration) · 功能概览 [§6](./features#_6-joint4-标定)。

## 3. Bridge / 协议（proposed）

当前 Bridge **无**通用 ROS action 客户端（Joint4 走专用 Tauri `call_joint4_calibration_service` + Trigger）。重力辨识建议经现有 WebSocket Bridge 扩展，名称如下——**均为 proposed，未实现前不得当已支持协议文档**；正式写入 [Bridge 协议](./protocol) 须随实现 PR。

### 3.1 建议 op

| op（proposed） | 方向 | 作用 |
|---|---|---|
| `gravity_id_send_goal` | Desk → Bridge | 发送 Goal（字段同 action Goal）；须带 `confirmation: "ARMED"` |
| `gravity_id_cancel` | Desk → Bridge | Cancel goal / abort |
| `gravity_id_feedback` | Bridge → Desk | 推送 Feedback（可节流，例如 ≤10 Hz） |
| `gravity_id_result` | Bridge → Desk | 终态 Result |
| `gravity_id_status`（可选） | Bridge → Desk | goal 句柄状态：accepted / executing / canceling / aborted |

示例（proposed）：

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
  "max_effort_nm": 1.0,
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

备选：若短期不扩 Bridge，可用受约束 SSH `ros2 action send_goal`（**不推荐**作默认路径：难做 Feedback 流、与「Mac 不直接 ROS」架构不一致）。实现优先 WebSocket op。

### 3.2 Action 字段摘要（权威在 stack#12）

**Goal：** `joint_mask`、`mode`（0 全臂 / 1 payload）、settle/capture、YAML + hot-reload、力矩/速度上限、`command_timeout_ms`、夹爪锁。

**Feedback：** `phase`、`pose_index`/`pose_count`、残差/力矩、`fault_code`、`message`。

**Result：** `gravity_scales`、`torque_biases_nm`、RMSE、`yaml_path`。

**Safety：** abort / 超时 / **命令丢失（fault 11）** → **HOLD**（非 DISABLE）。静置采样若需重力前馈：host 用 **TRACK、velocity≈0、effort=前馈**（现网 HOLD 将 MIT effort 置 0）。

### 3.3 固件故障码（现网十进制，权威在 executor）

草案早期曾用十六进制位标志（如 `0x0001`）；**现网 `HardwareStatus.fault_code` 为 uint16 枚举十进制序号，Desk/Bridge 原样透传，勿按位掩码解析。** 与 [rebotarm-executor#7](https://github.com/phamstered/rebotarm-executor/pull/7) 对齐的会话别名：

| 草案名 | 现网值 | 现网符号 | 会话内建议 |
|---|---:|---|---|
| `FAULT_NONE` | 0 | `MOTOR_FAULT_NONE` | 继续 |
| `FAULT_STALE_SEQUENCE` | **4** | `MOTOR_FAULT_STALE_SEQUENCE` | abort；按现网清序列/重启 |
| `FAULT_MOTOR` | **7** | `MOTOR_FAULT_DRIVE` | abort → HOLD；禁止继续激励 |
| `FAULT_CMD_LOSS` | **11** | `MOTOR_FAULT_COMMAND_LOSS_LATCHED` | abort → **HOLD**（非 DISABLE） |
| `FAULT_EFFORT_LIMIT`（近义） | 3 | `MOTOR_FAULT_COMMAND_LIMIT` | abort → HOLD（收命令时 kp/kd/effort 超限） |

速度/位置偏离、夹爪未锁、会话拒绝等仍可为 **ROS 侧**码（建议高位 `0x8000 | local`），勿占用固件 0–12。

### 3.4 辨识会话命令语义（现网）

| 阶段 | Host → 固件 | 说明 |
|---|---|---|
| 静置 / 采样（需前馈） | **`TRACK`，`velocity≈0`，`effort`=重力前馈** | 现网 **HOLD 清零 MIT effort**；仅锁存位置 + kp/kd。采样读 `JointState.effort` |
| 静置（无前馈） | `HOLD` | 可接受；effort 通道为 0 |
| 换姿 | 短暂 `TRACK` | 到位后切回静置策略 |
| Abort / cancel / 命令丢失 | → **HOLD** | **不**自动 DISABLE；DISABLE 仅走现有 `mode=3` / 断开会话 / 反馈超时等路径 |

命令流须持续发送；host 侧 `command_timeout_ms` 期望对齐约 **100 ms**（与固件 `COMMAND_TIMEOUT_MS`）。超过约 500 ms 锁存 fault **11** 并 HOLD。

## 4. 安全（不得弱化）

沿用 [AGENTS.md](../AGENTS.md) §3 与 Motor 页既有门控：

1. **ARMED**：非 Abort 的启动须安全确认；Bridge 拒绝缺少 `confirmation: "ARMED"` 的 send_goal（实现时与 `joint_command` 同策略）。
2. **运行中锁定**：`phase` 处于 ARMING…WRITING（含 ABORTING）时：
   - 禁用 Motor 页滑块 / 连续 JointCommand（除紧急 DISABLE）
   - 禁用 TCP 拖拽轨迹下发
   - 禁用与辨识互斥的 Joint4 Begin/Capture（若同会话打开）
3. **Abort**：UI Abort → `gravity_id_cancel` → stack abort → 固件 **HOLD**；界面显示「已 HOLD」。
4. **命令丢失（会话内）**：fault **11**（`FAULT_CMD_LOSS`）→ action ABORTING → **HOLD**；**不是** DISABLE。UI 展示十进制码与名称。
5. **断开 / 重连**（Desk 会话结束）：若辨识仍在执行，先 cancel（目标 HOLD）；再按现网「电机命令流在运行则 DISABLE」清理上位机命令流；清空辨识状态，避免旧 Feedback 污染新连接。
6. **急停与现场**：文档与 Joint4 相同——操作者托住/急停就绪；Desk 不替代物理急停。
7. **Effort 等限幅**：Desk 可展示 Goal 上限，**不得**为「方便测试」删除确认、反馈新鲜度、fault 展示或 ARMED 门。

## 5. 仓库职责对照

| 仓库 | 做什么 | 不做什么 |
|---|---|---|
| **robot-debug-desk** | 本设计 UI；日后 Bridge op + 页面 | 辨识算法、YAML 权威写入、固件超时策略 |
| **rebotarm-ros2-stack** | `/StartGravityID` 状态机、激励、拟合、热加载 | 固件字节协议、Desk 布局 |
| **rebotarm-executor** | meas、HOLD/TRACK（静置前馈用 TRACK@v≈0）、command-loss → HOLD、十进制 fault_code | 姿态规划、最小二乘、写 YAML；不采用草案 hex 位标志 |

## 6. 实现前检查清单（后续 PR）

- [ ] stack action 与 Feedback 字段稳定（对照 #12）
- [ ] Bridge 实现 proposed op + 单测；同步 `docs/protocol.md`
- [ ] 前端页面 + 与 Motor/TCP 互斥锁
- [ ] 会话内 command-loss / abort → HOLD；Desk 断开再走既有 DISABLE；fault 展示用十进制 4/7/11
- [ ] 静置前馈：TRACK @ v≈0（勿假设 HOLD 保留 effort）
- [ ] `docs/basic-features.md` 与功能概览改为「已实现」表述
- [ ] `npm test` 全绿

## 参考

- Stack 设计：[rebotarm-ros2-stack#12](https://github.com/phamstered/rebotarm-ros2-stack/pull/12) · `docs/gravity-identification.md`
- 固件契约：[rebotarm-executor#7](https://github.com/phamstered/rebotarm-executor/pull/7) · `docs/ros2-interface.md`「重力辨识会话」
- 现有手工标定：[Joint4 标定操作指南](./joint4-calibration)
- 协议（已实现部分）：[Bridge 协议](./protocol)
- 功能概览入口：[功能概览 · 重力辨识（设计）](./features#_8-重力辨识设计草案)
