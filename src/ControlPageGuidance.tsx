import { TerminalLink } from "./TerminalLink";
import { useId, useState, type ReactNode } from "react";
import "./controlPageGuidance.css";

/** One help and diagnostics entry shared by both control-page presentations. */
export function ControlPageGuidance({ children }: { children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const helpId = useId();
  return <div className="control-guidance" aria-label="控制说明与日志">
    <div className="control-guidance-header">
      {children ?? <span className="control-guidance-spacer" />}
      <div className="control-guidance-actions">
        <button type="button" aria-expanded={expanded} aria-controls={helpId} onClick={() => setExpanded(value => !value)}>操作说明</button>
        <TerminalLink>查看日志</TerminalLink>
      </div>
    </div>
      <div id={helpId} hidden={!expanded} className="control-guidance-content">
        <section><strong>Controller 管理</strong><p>默认全部加载并配置为 inactive，按需启用。停用 Controller 会保留加载状态，不等同于关闭电机输出。</p></section>
        <section><strong>模式切换</strong><p>安全停止旧模式 → 清理旧进程 → 启动并核验。退出拖动示教前，先支撑机械臂与物体，关闭输出后再切换。</p></section>
        <section><strong>退出控制</strong><p>回零退出会回到零位，确认输出关闭后退出，不是暂停或保持。直接关闭输出不回零，必须先现场支撑；任务结束以新鲜反馈核验为准。</p></section>
      </div>
  </div>;
}
