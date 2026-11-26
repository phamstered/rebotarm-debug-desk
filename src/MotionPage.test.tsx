import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useMotionReport } from "./MotionOutput";
import type { PositionMotionState } from "./positionMotionLogic";
import { MotionPage } from "./MotionPage";
import { Terminal } from "./Terminal";
import { terminalPublish } from "./terminalLogLogic";
import { defaultMotionLayout, MOTION_LAYOUT_KEY } from "./motionLayoutLogic";
const props={active:true,tab:"robot" as const,onTabChange:vi.fn(),controllersOpen:true,onToggleControllers:vi.fn(),controllers:<div>Controller operations</div>,readiness:null,robot:<div data-testid="scene">Retained scene</div>,positions:<div>Saved poses</div>,groups:<div>Action timeline</div>};
beforeEach(()=>localStorage.clear());
const reportToggle=()=>screen.getByRole("button",{name:/^执行报告 /});
it("restores saved sizes and resets report geometry without remounting the scene",async()=>{
 localStorage.setItem(MOTION_LAYOUT_KEY,JSON.stringify({controllersWidth:400,logHeight:320}));
 const user=userEvent.setup(),view=render(<MotionPage {...props}/>),scene=screen.getByTestId("scene");
 expect(screen.getByRole("separator",{name:"调整 Controllers 宽度"})).toHaveAttribute("aria-valuenow","400");
 expect(reportToggle()).toHaveAttribute("aria-expanded","false");
 await user.click(reportToggle());expect(screen.getByText(/暂无动作组执行报告/)).toBeVisible();
 view.rerender(<MotionPage {...props} resetVersion={1}/>);
 expect(reportToggle()).toHaveAttribute("aria-expanded","false");
 expect(JSON.parse(localStorage.getItem(MOTION_LAYOUT_KEY)!)).toEqual(defaultMotionLayout);
 expect(screen.getByTestId("scene")).toBe(scene);
});
it("preserves scene and editing across tabs/navigation and never mounts a local log output",async()=>{
 const user=userEvent.setup(),view=render(<MotionPage {...props}/>),scene=screen.getByTestId("scene");
 await user.click(screen.getByRole("tab",{name:"姿态库"}));expect(props.onTabChange).toHaveBeenCalledWith("positions");
 view.rerender(<MotionPage {...props} tab="positions"/>);expect(scene).not.toBeVisible();expect(screen.getByText("Saved poses")).toBeVisible();
 await user.click(screen.getByRole("tab",{name:"动作组"}));expect(props.onTabChange).toHaveBeenCalledWith("groups");
 view.rerender(<MotionPage {...props} tab="groups"/>);expect(screen.getByText("Action timeline")).toBeVisible();expect(screen.getByText("Saved poses")).not.toBeVisible();
 await user.click(screen.getByRole("button",{name:"收起 Controllers"}));expect(props.onToggleControllers).toHaveBeenCalledOnce();
 view.rerender(<MotionPage {...props} active={false} controllersOpen={false}/>);expect(scene).not.toBeVisible();
 view.rerender(<MotionPage {...props} controllersOpen={false}/>);expect(screen.getByTestId("scene")).toBe(scene);expect(scene).toBeVisible();expect(screen.getByText("Controller operations")).not.toBeVisible();
 expect(screen.queryByRole("tab",{name:"执行日志"})).toBeNull();expect(screen.queryByRole("log")).toBeNull();
 expect(screen.getByRole("button",{name:"查看 Motion 日志"})).toBeVisible();
});
function ReportPublisher({state}:{state?:PositionMotionState}){const open=useMotionReport(state,null);return <button onClick={open}>查看执行报告</button>;}
const reportState:PositionMotionState={commandId:"group-1",label:"取放",phase:"succeeded",message:"Action 成功，已停稳",group:{id:"group",count:2,index:1,phase:"holding",elapsed:15}};
it("does not open reports on completion; explicit reports retain their editor and clear on profile change",async()=>{
 const user=userEvent.setup(),view=render(<MotionPage {...props} tab="groups" groups={<ReportPublisher/>}/>),editor=screen.getByRole("button",{name:"查看执行报告"});
 view.rerender(<MotionPage {...props} tab="groups" groups={<ReportPublisher state={reportState}/>}/>);
 expect(reportToggle()).toHaveAttribute("aria-expanded","false");expect(screen.queryByRole("status",{name:"最近动作组执行结果"})).toBeNull();
 await user.click(editor);expect(screen.getByRole("status",{name:"最近动作组执行结果"})).toHaveTextContent("Action 成功，已停稳");
 view.rerender(<MotionPage {...props} tab="groups" active={false} groups={<ReportPublisher state={reportState}/>}/>);
 view.rerender(<MotionPage {...props} tab="groups" groups={<ReportPublisher state={reportState}/>}/>);
 expect(screen.getByRole("button",{name:"查看执行报告"})).toBe(editor);expect(screen.getByRole("status",{name:"最近动作组执行结果"})).toHaveTextContent("取放");
 view.rerender(<MotionPage {...props} tab="groups" groups={<ReportPublisher key="new-profile"/>}/>);
 expect(screen.queryByRole("status",{name:"最近动作组执行结果"})).toBeNull();expect(screen.getByText(/暂无动作组执行报告/)).toBeVisible();
});
it("keeps Terminal filters, scroll and incoming ROS logs independent of report and page visibility",async()=>{
 const user=userEvent.setup();terminalPublish({source:"moveit",message:"planner initial",level:"info"});
 const view=render(<><MotionPage {...props}/><Terminal/></>);
 const log=screen.getByRole("log");await waitFor(()=>expect(log).toHaveTextContent("planner initial"));
 await user.selectOptions(screen.getByLabelText("日志来源"),"moveit");await user.type(screen.getByRole("searchbox"),"planner");
 fireEvent.wheel(log,{deltaY:-100});log.scrollTop=123;
 await user.click(reportToggle());await user.click(reportToggle());
 expect(screen.getByRole("searchbox")).toHaveValue("planner");expect(log.scrollTop).toBe(123);expect(screen.getByLabelText("跟随最新")).not.toBeChecked();
 view.rerender(<><MotionPage {...props} active={false}/><Terminal/></>);
 terminalPublish({source:"moveit",message:"planner while hidden",level:"info"});await waitFor(()=>expect(log).toHaveTextContent("planner while hidden"));
 expect(screen.getAllByRole("log")).toHaveLength(1);
});
it("starts compact report folded, preserves scene in focus and exits focus on explicit report access",async()=>{
 const user=userEvent.setup(),exit=vi.fn(),view=render(<MotionPage {...props} compact onToggleFocus={exit}/>),scene=screen.getByTestId("scene");
 expect(reportToggle()).toHaveAttribute("aria-expanded","false");await user.click(reportToggle());expect(screen.getByText(/暂无动作组执行报告/)).toBeVisible();
 view.rerender(<MotionPage {...props} compact focusMode onToggleFocus={exit}/>);expect(screen.queryByText(/暂无动作组执行报告/)).toBeNull();expect(screen.getByText("Controller operations")).not.toBeVisible();expect(screen.getByTestId("scene")).toBe(scene);
 await user.click(reportToggle());expect(exit).toHaveBeenCalledOnce();view.rerender(<MotionPage {...props} compact/>);expect(screen.getByText("Controller operations")).toBeVisible();
});
it("opens URDF without robot controls, and keeps visible drafts when only drawing is suspended",async()=>{
 const user=userEvent.setup(),view=render(<MotionPage {...props} urdf={<div>Model inspection</div>}/>);
 await user.click(screen.getByRole("tab",{name:"URDF"}));expect(props.onTabChange).toHaveBeenCalledWith("urdf");
 view.rerender(<MotionPage {...props} tab="urdf" urdf={<div>Model inspection</div>}/>);expect(screen.getByText("Model inspection")).toBeVisible();expect(screen.getByTestId("scene")).not.toBeVisible();
 view.rerender(<MotionPage {...props} active={false} visible tab="positions" positions={<input aria-label="Draft" defaultValue="retained"/>}/>);expect(screen.getByLabelText("Draft")).toBeVisible();
 view.rerender(<MotionPage {...props} active={false} visible={false} tab="positions" positions={<input aria-label="Draft" defaultValue="retained"/>}/>);expect(screen.getByLabelText("Draft")).not.toBeVisible();
});
