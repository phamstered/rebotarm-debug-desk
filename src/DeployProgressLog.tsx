import { TerminalLink } from "./TerminalLink";
import { useTerminalLines } from "./terminalLogLogic";
import { nativeDesktop } from "./nativeWorkspaceLogic";

export function DeployProgressLog({ lines }: { lines: string[] }) {
  useTerminalLines("Deploy", nativeDesktop() ? [] : lines);
  return <TerminalLink source="Deploy">查看部署日志</TerminalLink>;
}
