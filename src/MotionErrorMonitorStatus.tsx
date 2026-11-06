import { useEffect, useState } from "react";
import { ARM_ERROR_CONTROLLER_TOPIC, EMPTY_MOTION_ERROR_STATUS, MOTION_ERROR_MAX_AGE_MS, type MotionErrorStatus } from "./motionErrorMonitorLogic";

export function MotionErrorMonitorStatus({ status = EMPTY_MOTION_ERROR_STATUS, jointStateTopic, liveUpdates, subscriptionError = "" }: {
  status?: MotionErrorStatus; jointStateTopic: string; liveUpdates: boolean; subscriptionError?: string;
}) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!liveUpdates) return;
    setNow(performance.now());
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [liveUpdates]);
  const age = (at: number | null) => at == null ? "等待数据" : now - at >= MOTION_ERROR_MAX_AGE_MS ? "已过期" : `${Math.max(0, Math.round(now - at))} ms 前`;
  const expired = liveUpdates && [status.controllerAt, status.stm32At].some(at => at != null && now - at >= MOTION_ERROR_MAX_AGE_MS);
  return <section className="motion-error-monitor-status" aria-label="运动误差数据说明">
    <p><strong>轨迹跟踪：</strong>同一条 JTC 消息的 desired − actual，单位 rad。
      <strong> 反馈差值：</strong>JTC actual − STM32 position，按 joint1–joint6 名称匹配。</p>
    <details><summary>两路最新采样未对齐 · 查看计算口径与限制</summary>
    <p>反馈差值使用桌面收到的两路最新采样，<strong>未做时间对齐</strong>，不能直接当作跟踪误差或 Bridge 告警复现。
      Bridge 现比较 JTC 与 JointState Broadcaster /joint_states（阈值 0.02 rad）；本图保留 STM32 原始反馈用于底层链路诊断，不是该门禁的比较源。</p>
    <p>时间差：header_stamp_ms 为 JTC 更新时间 − STM32 源时间；receive_time_ms 为桌面接收时间差，均为 ms，均不代表端到端延迟。
      默认使用散点，缺失/无效/过期数据不补零。</p>
    </details>
    <div className="motion-error-monitor-sources">
      <span><code>{ARM_ERROR_CONTROLLER_TOPIC}</code> · {age(status.controllerAt)}</span>
      <span><code>{jointStateTopic}</code> · {age(status.stm32At)}</span>
    </div>
    <p role="status">{!liveUpdates ? "已暂停：保留历史，恢复后等待新采样。" : subscriptionError || (expired ? "反馈已过期：保留历史点，等待新采样。" : `跟踪：${status.tracking}。反馈：${status.feedback}。`)}</p>
  </section>;
}
