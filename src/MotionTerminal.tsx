import type { MotionLogEntry } from "./types";
import type { ReactNode } from "react";
import { TerminalLink } from "./TerminalLink";

/** Legacy embedding entry: all output is now owned by the global Terminal. */
export function MotionTerminal(_props: { logs: MotionLogEntry[]; active: boolean; plannerLog?: ReactNode | ((active: boolean) => ReactNode) }) {
  return <TerminalLink source="Motion">查看 Motion 日志</TerminalLink>;
}
