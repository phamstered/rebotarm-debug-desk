import type { ControlLogSource } from "./types";

export const CONTROL_LOG_SOURCES: Array<{ id: ControlLogSource; label: string }> = [
  { id: "teleop", label: "Teleop" },
  { id: "trajectory", label: "Trajectory" },
  { id: "vla", label: "VLA" },
  { id: "controller", label: "ROS 控制器（最新文件）" },
  { id: "realsense", label: "RealSense" },
];

export function controlLogLines(content: string, search = ""): string[] {
  // Strip terminal colors/cursor commands and OSC hyperlinks before searching.
  const plain = content.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const lines = plain ? plain.replace(/\n$/, "").split("\n") : [];
  const needle = search.toLocaleLowerCase();
  return needle ? lines.filter((line) => line.toLocaleLowerCase().includes(needle)) : lines;
}
