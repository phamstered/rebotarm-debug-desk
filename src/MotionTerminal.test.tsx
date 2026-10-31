import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MotionTerminal } from "./MotionTerminal";
import type { MotionLogEntry } from "./types";
const mocks = vi.hoisted(() => ({ save: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const logs: MotionLogEntry[] = [
  { seq: 1, timestamp_ms: 1000, command_id: "motion-1", phase: "planning", message: "target joint1=.2", level: "info" },
  { seq: 2, timestamp_ms: 2000, command_id: "motion-1", phase: "failed", message: "Controller timeout", level: "error" },
];
beforeEach(() => { mocks.save.mockReset(); mocks.invoke.mockReset(); });
it("searches without discarding records, exports unfiltered history and reports errors", async () => {
  render(<MotionTerminal active logs={logs} />);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "TIMEOUT" } });
  expect(screen.getByLabelText("规划日志输出")).toHaveTextContent("Controller timeout");
  expect(screen.getByLabelText("规划日志输出")).not.toHaveTextContent("target joint1");
  mocks.save.mockResolvedValue("/tmp/motion.log");
  mocks.invoke.mockRejectedValueOnce(new Error("disk full"));
  fireEvent.click(screen.getByText("导出日志"));
  await waitFor(() => expect(screen.getByText(/导出失败/)).toHaveTextContent("disk full"));
  expect(mocks.invoke).toHaveBeenCalledWith("save_motion_log", { localPath: "/tmp/motion.log", content: expect.stringContaining("target joint1=.2") });
  fireEvent.click(screen.getByText("导出日志"));
  await waitFor(() => expect(screen.getByText(/日志已导出/)).toBeInTheDocument());
});
it("retains logs when collapsed, mounts raw planner only when selected, and follows only on request", () => {
  const view = render(<MotionTerminal active logs={logs} plannerLog={<div>raw planner output</div>} />);
  expect(screen.queryByText("raw planner output")).not.toBeInTheDocument();
  const pre = screen.getByLabelText("规划日志输出");
  Object.defineProperties(pre, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  pre.scrollTop = 0;
  fireEvent.scroll(pre);
  expect(screen.getByRole("checkbox", { name: "跟随最新" })).toBeChecked();
  fireEvent.wheel(pre); fireEvent.scroll(pre);
  expect(screen.getByRole("checkbox", { name: "跟随最新" })).not.toBeChecked();
  view.rerender(<MotionTerminal active logs={[...logs, { ...logs[0], seq: 3 }]} plannerLog={<div>raw planner output</div>} />);
  expect(pre.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole("checkbox", { name: "跟随最新" }));
  expect(pre.scrollTop).toBe(1000);
  fireEvent.change(screen.getByLabelText("规划日志来源"), { target: { value: "moveit" } });
  expect(screen.getByText("raw planner output")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /规划执行日志/ }));
  expect(screen.queryByText("raw planner output")).not.toBeInTheDocument();
  expect(screen.getByText(/3 条/)).toBeInTheDocument();
});
