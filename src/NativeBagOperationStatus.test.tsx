import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeBagOperationStatus } from "./NativeBagOperationStatus";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),listeners:new Set<()=>void>()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async (_:string,cb:()=>void)=>{mocks.listeners.add(cb);return()=>mocks.listeners.delete(cb);})}));
const task={id:1,kind:"record",window:"page-motion",host:"fixture",starting:false,phase:"uncertain",message:"远端记录待核验"};
const changed=()=>mocks.listeners.forEach(fn=>fn());
beforeEach(()=>{mocks.invoke.mockReset();mocks.listeners.clear();});afterEach(cleanup);
it("retains unknown operations across windows and hides only confirmed success",async()=>{
  mocks.invoke.mockResolvedValue([task]);render(<NativeBagOperationStatus/>);
  expect(await screen.findByRole("status")).toHaveTextContent("fixture · Motion · 录制停止 · 结果未确认");
  mocks.invoke.mockResolvedValue([{...task,phase:"verifying",message:"新鲜状态待核验"}]);await act(async()=>changed());
  expect(screen.getByRole("status")).toHaveTextContent("核验中");
  mocks.invoke.mockResolvedValue([{...task,phase:"succeeded"}]);await act(async()=>changed());
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.invoke.mock.calls.every(([name])=>name==="native_bag_operation_snapshot")).toBe(true);
});
it("coalesces invalidation and never paints an obsolete initial operation",async()=>{
  let resolve!:(value:unknown)=>void;mocks.invoke.mockReturnValueOnce(new Promise(done=>{resolve=done;})).mockResolvedValue([]);
  const view=render(<NativeBagOperationStatus/>);await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledTimes(1));
  act(()=>{changed();changed();});expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async()=>resolve([task]));await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("status")).toBeNull();view.unmount();expect(mocks.listeners.size).toBe(0);
});
it("shows query failures instead of claiming there is no pending operation",async()=>{
  mocks.invoke.mockRejectedValue(new Error("IPC unavailable"));render(<NativeBagOperationStatus/>);
  expect(await screen.findByRole("status")).toHaveTextContent("任务状态不可用");
});

it("keeps a running playback visible until process exit is confirmed",async()=>{
  mocks.invoke.mockResolvedValue([{...task,kind:"play",window:"page-monitor",phase:"running",message:"进程组运行中"}]);
  render(<NativeBagOperationStatus/>);
  expect(await screen.findByRole("status")).toHaveTextContent("回放 · 运行中");
  mocks.invoke.mockResolvedValue([{...task,kind:"play",phase:"uncertain",message:"进程身份待核验"}]);await act(async()=>changed());
  expect(screen.getByRole("status")).toHaveTextContent("进程身份待核验");
  mocks.invoke.mockResolvedValue([{...task,kind:"play",phase:"succeeded"}]);await act(async()=>changed());
  expect(screen.queryByRole("status")).toBeNull();
});
