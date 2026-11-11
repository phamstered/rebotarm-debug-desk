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
