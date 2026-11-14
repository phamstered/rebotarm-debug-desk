import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeCollectionOperationStatus } from "./NativeCollectionOperationStatus";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, callback: () => void) => {
  mocks.listeners.add(callback); return () => mocks.listeners.delete(callback);
}) }));
const task = { id: 1, action: "save_episode", phase: "uncertain", host: "fixture", busy: true, message: "仅查询，不重发" };
const changed = () => mocks.listeners.forEach(callback => callback());
beforeEach(() => { mocks.invoke.mockReset(); mocks.listeners.clear(); }); afterEach(cleanup);
it("shares pending and ongoing Episode ownership, and hides only confirmed completion", async () => {
  mocks.invoke.mockResolvedValue(task); render(<NativeCollectionOperationStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("保存 Episode · 结果未确认");
  mocks.invoke.mockResolvedValue({ ...task, phase: "recording" }); await act(async () => changed());
  expect(screen.getByRole("status")).toHaveTextContent("采集中");
  mocks.invoke.mockResolvedValue({ ...task, phase: "succeeded", busy: false }); await act(async () => changed());
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.invoke.mock.calls.every(([command]) => command === "native_collection_operation_snapshot")).toBe(true);
});
it("does not restore an old operation when a late initial snapshot resolves", async () => {
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValue(null);
  const view = render(<NativeCollectionOperationStatus />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
  act(() => { changed(); changed(); });
  await act(async () => resolve(task));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("status")).toBeNull(); view.unmount();
  expect(mocks.listeners.size).toBe(0);
});
it("shows a failed snapshot read as unavailable rather than idle", async () => {
  mocks.invoke.mockRejectedValue(new Error("IPC unavailable")); render(<NativeCollectionOperationStatus />);
  expect(await screen.findByRole("status")).toHaveTextContent("采集任务状态不可用");
});

it("labels journal corruption as recovery failure without claiming a dataset finish", async () => {
  mocks.invoke.mockResolvedValue({...task,id:0,action:"finish",recovery_error:true,busy:false,message:"采集恢复记录不可用"});
  render(<NativeCollectionOperationStatus/>);
  const status=await screen.findByRole("status");
  expect(status).toHaveTextContent("任务恢复异常 · 采集恢复记录不可用");
  expect(status).not.toHaveTextContent("完成数据集");
});
