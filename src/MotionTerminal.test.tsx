import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MotionTerminal } from "./MotionTerminal";
import { openTerminal } from "./terminalLogLogic";
vi.mock("./terminalLogLogic",async original=>({...await original<typeof import("./terminalLogLogic")>(),openTerminal:vi.fn()}));
it("redirects legacy embedding to Terminal without mounting an independent log or raw planner reader",()=>{
 const reader=vi.fn();const logs=[{seq:1,timestamp_ms:1000,command_id:"motion-1",phase:"failed",message:"Controller timeout",level:"error" as const}];
 const view=render(<MotionTerminal active logs={logs} plannerLog={reader}/>);
 expect(screen.queryByText("Controller timeout")).toBeNull();expect(screen.queryByRole("searchbox")).toBeNull();expect(reader).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"查看 Motion 日志"}));expect(openTerminal).toHaveBeenLastCalledWith("Motion",undefined,"main");
 view.rerender(<MotionTerminal active={false} logs={[]} plannerLog={reader}/>);expect(reader).not.toHaveBeenCalled();
});
