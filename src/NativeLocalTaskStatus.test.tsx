import { act, render, screen, waitFor } from "@testing-library/react";
import { expect,it,vi } from "vitest";
import { NativeLocalTaskStatus } from "./NativeLocalTaskStatus";
const mock=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mock.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:mock.listen}));
it("observers recover terminal errors without issuing owner renewals or exposing results",async()=>{
  let handler!:()=>void;
  mock.listen.mockImplementation(async(_,fn)=>{handler=fn;return()=>{};});
  mock.invoke.mockResolvedValue({id:1,window:"page-handeye",kind:"compute",phase:"running",message:"处理中"});
  render(<NativeLocalTaskStatus/>);
  expect(await screen.findByLabelText("原生手眼任务")).toHaveTextContent("手眼计算 · 处理中");
  mock.invoke.mockResolvedValue({id:1,window:"page-handeye",kind:"compute",phase:"cancelled",message:"页面失联"});
  act(()=>handler());await waitFor(()=>expect(screen.getByLabelText("原生手眼任务")).toHaveTextContent("已取消 · 页面失联"));
  expect(mock.invoke.mock.calls.every(([command])=>command==="native_local_task_snapshot")).toBe(true);
});
