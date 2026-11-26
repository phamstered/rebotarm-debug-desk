import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { ControlLogViewer } from "./ControlLogViewer";
import { openTerminal } from "./terminalLogLogic";
const invoke=vi.hoisted(()=>vi.fn());
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("./terminalLogLogic",async original=>({...await original<typeof import("./terminalLogLogic")>(),openTerminal:vi.fn()}));
afterEach(()=>vi.useRealTimers());
it.each(["teleop","trajectory","controller","teaching","moveit","realsense","vla"] as const)("routes %s to the native global collector rather than creating a page reader",source=>{
 render(<ControlLogViewer profile={defaultProfile} active connected preferredSource={source}/>);
 fireEvent.click(screen.getByRole("button",{name:"查看控制日志"}));
 expect(openTerminal).toHaveBeenLastCalledWith(source==="vla"?"trajectory":source,undefined,"main");
 expect(screen.queryByRole("log")).toBeNull();expect(screen.queryByRole("searchbox")).toBeNull();expect(invoke).not.toHaveBeenCalled();
});
it("never starts a second remote poll or holds stale output across hidden tabs and host changes",async()=>{
 vi.useFakeTimers();const view=render(<ControlLogViewer profile={defaultProfile} active connected/>);
 await act(async()=>vi.advanceTimersByTimeAsync(5000));
 view.rerender(<ControlLogViewer profile={{...defaultProfile,host:"other"}} active={false} connected={false}/>);
 await act(async()=>vi.advanceTimersByTimeAsync(5000));
 expect(invoke).not.toHaveBeenCalled();expect(screen.queryByLabelText("日志输出")).toBeNull();
 expect(screen.getByRole("button",{name:"查看控制日志"})).toBeEnabled();
});
