import type { ConnectionProfile } from "./types";
import { TerminalLink } from "./TerminalLink";
import type { ControlLogSource } from "./types";

/** ROS file polling belongs to the native Terminal collector, never a page. */
export function ControlLogViewer({ preferredSource = "teleop" }: { profile: ConnectionProfile; active: boolean; connected: boolean; preferredSource?: ControlLogSource }) {
  return <TerminalLink source={preferredSource === "vla" ? "trajectory" : preferredSource}>查看控制日志</TerminalLink>;
}
