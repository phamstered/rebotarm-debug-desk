import type { ClockSyncStatus as Status } from "./clockSyncLogic";
const labels: Record<Status["state"], string> = { waiting: "等待同步", synchronized: "时间已对齐", unsynchronized: "时间失步", stale: "状态过期", unsupported: "诊断不支持", disconnected: "未连接" };
export function ClockSyncStatus({ value }: { value: Status }) {
  const offset = value.source_offset_ms;
  return <div className={`clock-sync-status ${value.state === "synchronized" ? "ok" : "muted"}`} aria-label="时钟同步" style={{ overflowWrap: "anywhere" }}>
    <strong>时钟同步 · {labels[value.state]}</strong>
    {offset !== undefined && <span> · {offset >= 0 ? "超前" : "落后"} {Math.abs(offset).toFixed(1)} ms</span>}
    <p>{value.message}</p>
    <details><summary>时间诊断详情</summary><p>相对 Jetson · {value.source_topic || "等待反馈源"} · 时间代次 {value.generation}</p>
      {value.feedback_age_ms !== undefined && <p>反馈接收帧龄 {value.feedback_age_ms.toFixed(0)} ms</p>}
      {value.firmware?.supported && <p>固件同步：{value.firmware.synchronized === true ? "已同步" : value.firmware.synchronized === false ? "未同步" : "待确认"}{value.firmware.sync_age_ms !== undefined ? ` · 距成功同步 ${value.firmware.sync_age_ms.toFixed(0)} ms` : ""}</p>}
    </details>
  </div>;
}
