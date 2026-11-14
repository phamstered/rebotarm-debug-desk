import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeTaskStatus } from "./NativeTaskStatus";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); }) }));
const task = { id: 1, epoch: 2, window: "page-motion", command_id: "x", kind: "pick", phase: "stopping", message: "等待 Bridge 确认任务终态" };
const changed = () => mocks.listeners.forEach(listener => listener());
beforeEach(() => { mocks.invoke.mockReset(); mocks.listeners.clear(); });
afterEach(cleanup);

it("shows ownership and unconfirmed stop until the native terminal clears it", async () => {
  mocks.invoke.mockResolvedValue(task);
  const { unmount } = render(<NativeTaskStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("Motion · 视觉抓取 · 等待停止确认");
  mocks.invoke.mockResolvedValue({ ...task, phase: "uncertain", message: "Bridge 未能确认停止" });
  await act(async () => changed());
  expect(screen.getByRole("status")).toHaveTextContent("停止未确认");
  mocks.invoke.mockResolvedValue(null);
  await act(async () => changed());
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.invoke.mock.calls.every(([command]) => command === "native_task_snapshot")).toBe(true);
  unmount(); expect(mocks.listeners.size).toBe(0);
});

it("serializes invalidations so a delayed initial read cannot overwrite a newer terminal", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue(null);
  render(<NativeTaskStatus />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  act(() => { changed(); changed(); changed(); });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => resolve(task));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("status")).toBeNull();
});

it("reports native read failures rather than displaying a false idle state", async () => {
  mocks.invoke.mockRejectedValue(new Error("IPC unavailable"));
  render(<NativeTaskStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("原生任务状态查询失败");
});


it("keeps Motor output confirmation visible after a publish ACK without renewing the stream", async () => {
  mocks.invoke.mockResolvedValue({ ...task, window: "page-motor", kind: "motor", message: "DISABLE 已发布，等待新鲜 HardwareStatus 确认输出关闭" });
  render(<NativeTaskStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("Motor 连续发送 · 等待停止确认");
  expect(screen.getByRole("status")).toHaveTextContent("等待新鲜 HardwareStatus");
  mocks.invoke.mockResolvedValue(null);
  await act(async () => changed());
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.invoke.mock.calls.every(([command]) => command === "native_task_snapshot")).toBe(true);
});


it("labels Controller uncertainty without claiming the remote operation has stopped", async () => {
  mocks.invoke.mockResolvedValue({ ...task, kind: "controller", phase: "uncertain", message: "等待原机器人新状态核验" });
  render(<NativeTaskStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("Motion · Controller 切换 · 结果未确认");
  expect(mocks.invoke.mock.calls.every(([command]) => command === "native_task_snapshot")).toBe(true);
});

it("keeps arm environment ownership visible across windows until native verification completes", async () => {
  mocks.invoke.mockResolvedValue({...task, window:"page-status", kind:"arm_mode", phase:"running", message:"启动并核验目标控制器"});
  render(<NativeTaskStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("Status · 控制环境切换 · 执行中");
  mocks.invoke.mockResolvedValue({...task, window:"page-status", kind:"arm_mode", phase:"uncertain", message:"等待原机器人状态"});
  await act(async () => changed());
  expect(screen.getByRole("status")).toHaveTextContent("控制环境切换 · 结果未确认");
  mocks.invoke.mockResolvedValue(null);
  await act(async () => changed());
  expect(screen.queryByRole("status")).toBeNull();
});

it("requests correlated direct trajectory cancellation and keeps the task after IPC returns", async () => {
  const direct = { ...task, kind: "trajectory", phase: "running", message: "Bridge 已受理" };
  mocks.invoke.mockImplementation(async command => command === "native_task_snapshot" ? direct : undefined);
  render(<NativeTaskStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("直接 JTC 轨迹 · 执行中");
  await act(async () => { screen.getByRole("button", { name: "取消直接轨迹" }).click(); screen.getByRole("button", { name: "取消直接轨迹" }).click(); });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "native_trajectory_cancel")).toEqual([
    ["native_trajectory_cancel", { id: 1, commandId: "x" }],
  ]);
  expect(screen.getByRole("status")).toHaveTextContent("直接 JTC 轨迹");
  expect(screen.getByRole("button", { name: "取消直接轨迹" })).toBeDisabled();
  mocks.invoke.mockResolvedValue({ ...direct, phase: "stopping", message: "等待停止证据" });
  await act(async () => changed());
  expect(screen.getByRole("status")).toHaveTextContent("等待停止证据");
  mocks.invoke.mockResolvedValue(null); await act(async () => changed());
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps direct trajectory ownership after cancel IPC failure and permits retry", async () => {
  const direct = { ...task, kind: "trajectory", phase: "running" };
  mocks.invoke.mockImplementation(async command => {
    if (command === "native_trajectory_cancel") throw new Error("IPC failed");
    return direct;
  });
  render(<NativeTaskStatus />);
  await screen.findByRole("status");
  await act(async () => screen.getByRole("button", { name: "取消直接轨迹" }).click());
  expect(screen.getByRole("alert")).toHaveTextContent("IPC failed");
  expect(screen.getByRole("button", { name: "取消直接轨迹" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("直接 JTC 轨迹");
});

it("does not apply a late cancel error to a replacement task", async () => {
  let reject!: (reason: Error) => void;
  let current = { ...task, kind: "trajectory", phase: "running" };
  mocks.invoke.mockImplementation(command => command === "native_trajectory_cancel"
    ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve(current));
  render(<NativeTaskStatus />); await screen.findByRole("status");
  act(() => screen.getByRole("button", { name: "取消直接轨迹" }).click());
  current = { ...current, id: 2, command_id: "next" }; await act(async () => changed());
  await act(async () => reject(new Error("old cancellation failed")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "取消直接轨迹" })).toBeEnabled();
});
