import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { OperationLogNotice } from "./OperationLogNotice";
import { Terminal } from "./Terminal";
import { NativePageActionsContext } from "./NativePageActions";
import { terminalOutput } from "./test/terminal";
beforeEach(()=>localStorage.clear());
it("renders a compact outcome on the page and puts complete success and error output only in Terminal",async()=>{
 const user=userEvent.setup();const page=render(<OperationLogNotice source="Handeye" notice="solver: done\ntranslation: validated" error="capture: disk full\ntrace: write image failed"/>);
 expect(within(page.container).getByRole("alert")).toHaveTextContent("操作失败，详情已记录");
 expect(page.container).not.toHaveTextContent("disk full");expect(page.container).not.toHaveTextContent("translation");
 render(<Terminal/>);await user.click(within(page.container).getByRole("button",{name:"查看操作日志"}));
 await waitFor(()=>expect(screen.getByRole("log")).toHaveTextContent("disk full"));
 expect(screen.getByRole("log")).toHaveTextContent("translation: validated");expect(screen.getByLabelText("日志来源")).toHaveValue("Handeye");
 page.unmount();expect(await terminalOutput("Handeye")).toContain("trace: write image failed");
});
it.each(["Collection","Gravity","Motor","Motion","Monitor","Controller"])("retains %s output after page unmount without rendering raw logs locally",async(source)=>{
 const page=render(<OperationLogNotice source={source} notice={`${source} first operation`}/>);
 page.rerender(<OperationLogNotice source={source} notice={`${source} second operation`}/>);
 expect(page.container).not.toHaveTextContent("second operation");expect(page.container.querySelector("pre")).toBeNull();
 page.unmount();expect(await terminalOutput(source)).toContain(`${source} first operation`);expect(await terminalOutput(source)).toContain(`${source} second operation`);
});
it("targets the detached window's Terminal without changing the main window filters",async()=>{
 const user=userEvent.setup();const main=render(<Terminal/>),detached=render(<Terminal windowKey="handeye"/>);
 const page=render(<NativePageActionsContext.Provider value={{page:"handeye",state:{detached:true} as any,connected:false,busyReason:"",onAction:()=>{}}}><OperationLogNotice source="Handeye" notice="offline solve complete"/></NativePageActionsContext.Provider>);
 await user.click(within(page.container).getByRole("button",{name:"查看操作日志"}));
 expect(within(detached.container).getByLabelText("日志来源")).toHaveValue("Handeye");expect(within(main.container).getByLabelText("日志来源")).toHaveValue("");
 await waitFor(()=>expect(within(detached.container).getByRole("log")).toHaveTextContent("offline solve complete"));
});
it("records identical notice and error once at error severity",async()=>{
 render(<OperationLogNotice source="Gravity" error="unique duplicate outcome" notice="unique duplicate outcome"/>);
 expect((await terminalOutput("Gravity")).split("unique duplicate outcome")).toHaveLength(2);
});
