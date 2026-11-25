import { useContext } from "react";
import { NativePageActionsContext } from "./NativePageActions";
import { openTerminal } from './terminalLogLogic';
export function TerminalLink({ source, task, children = '在 Terminal 查看日志' }: { source?: string; task?: string; children?: React.ReactNode }) {
  const context=useContext(NativePageActionsContext);
  const target=context&&(context.state?.detached||context.state?.recovery_required)?context.page:"main";
  return <button type="button" className="terminal-link" onClick={() => openTerminal(source, task, target)}>{children}</button>;
}
