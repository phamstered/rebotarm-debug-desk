# Status 四区布局（desk UI）

日期：2026-10-23  
仓库：`phamstered/rebotarm-debug-desk`  
范围：Status 页 UI/layout only（不改 ros2-stack / firmware）

## 目标

把原先平坦的约 13 张等权卡片，收成四个固定分区，降低噪声、突出硬件健康与互斥模式启停。

## 四区

1. **连接** — SSH · Bridge · Agent 紧凑摘要  
   - DDS Domain 并入 Bridge 次要行  
   - systemd 并入 Agent 次要行（P1 merge）
2. **硬件健康（主区）** — USB CDC/ACM（`0483:5740` / ttyACM，不与 RealSense 混排）· `/stm32/status`（mode / fault_code / **last_command_sequence**）· ros2_control · JointState Hz  
   - 页级 sticky alert：fault≠0 / HOLD / fault 11
3. **控制模式** — 单一互斥模式条 Teleop | Trajectory | VLA + 停止 / 解除输出  
   - 详情只展示**当前活跃模式**；闲置模式不用 warn tone  
   - 去掉模式卡片上的重复主启动按钮  
   - VLA 切换成功后突出 TRACK vs HOLD/safe_stop 闩锁
4. **传感器 / 高级** — RealSense（保留其 USB 行）；默认折叠；去掉常年「未知」噪声行（最近部署 / XRCE / Bridge journal 等）

## 安全非回归（#105 / #106）

- fault 11 禁用 Teleop/VLA/采集启动  
- HOLD 非 ok tone + 下垂警告  
- DISABLE 确认模态  
- VLA 拒绝停止 desk 持有的 ros2_control 脚本（既有逻辑）  
- HOLD 失败中止切换（既有逻辑）  
- `disabledReason` 页面可见，不仅 title

## 实现要点

- `statusLogic.ts`：`buildStatusCards` + `groupStatusZones` + `buildHardwareStickyAlert` + `resolveActiveControlMode`  
- `StatusPage.tsx`：分区渲染；控制区模式条；传感器 `<details>`  
- Top-bar Fault chip → Hardware 高亮（`App.tsx`）保持不变
