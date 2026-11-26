import { TerminalLink } from "./TerminalLink";
import { logLevel, useTerminalMessage } from "./terminalLogLogic";

/** Keep raw operation output in the shared log, with a compact local outcome. */
export function OperationLogNotice({ source, error = "", notice = "", label = "操作记录已更新" }: {
  source: string;
  error?: string;
  notice?: string;
  label?: string;
}) {
  useTerminalMessage(source, error, "error");
  useTerminalMessage(source, notice === error ? "" : notice);
  const failed=Boolean(error) || Boolean(notice && logLevel(notice)==="error");
  return <div className="operation-log-notice" role={failed ? "alert" : notice ? "status" : undefined}>
    {(error || notice) && <span>{failed ? "操作失败，详情已记录" : label}</span>}
    <TerminalLink source={source}>查看操作日志</TerminalLink>
  </div>;
}
