import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useMotionReport } from "./MotionOutput";
import type { PositionMotionState } from "./positionMotionLogic";
import { MotionPage } from "./MotionPage";
import { MotionTerminal } from "./MotionTerminal";
import { defaultMotionLayout, MOTION_LAYOUT_KEY } from "./motionLayoutLogic";

describe("Motion workspace", () => {
  it("restores saved sizes and resets geometry plus folded logs without remounting the scene", async () => {
    localStorage.setItem(MOTION_LAYOUT_KEY, JSON.stringify({ controllersWidth: 400, logHeight: 320 }));
    const props = { active: true, tab: "robot" as const, onTabChange: vi.fn(), controllersOpen: true,
      onToggleControllers: vi.fn(), controllers: <div>Controllers</div>, readiness: null,
      robot: <div data-testid="retained-model" />, positions: null, log: <MotionTerminal active logs={[]} /> };
    const user = userEvent.setup(); const { rerender } = render(<MotionPage {...props} />);
    const scene = screen.getByTestId("retained-model");
    expect(screen.getByRole("separator", { name: "调整 Controllers 宽度" })).toHaveAttribute("aria-valuenow", "400");
    await user.click(screen.getByRole("button", { name: "收起执行面板" }));
    expect(screen.queryByRole("searchbox", { name: "搜索规划日志" })).not.toBeInTheDocument();
    rerender(<MotionPage {...props} resetVersion={1} />);
    expect(screen.getByRole("searchbox", { name: "搜索规划日志" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(MOTION_LAYOUT_KEY)!)).toEqual(defaultMotionLayout);
    expect(screen.getByTestId("retained-model")).toBe(scene);
  });
  it("preserves the scene across tabs/navigation with independent controller visibility", async () => {
    const onTabChange = vi.fn(), onToggleControllers = vi.fn();
    const props = { active: true, tab: "robot" as "robot" | "positions" | "groups", onTabChange,
      controllersOpen: true, onToggleControllers, controllers: <div>Controller operations</div>,
      readiness: <span>等待新鲜反馈</span>, robot: <div data-testid="scene">Retained scene</div>,
      positions: <div>Saved poses</div>, groups: <div>Action timeline</div>, log: <div>Shared motion log</div> };
    const user = userEvent.setup(); const { rerender } = render(<MotionPage {...props} />);
    const scene = screen.getByTestId("scene");
    await user.click(screen.getByRole("tab", { name: "姿态库" }));
    expect(onTabChange).toHaveBeenCalledWith("positions");
    rerender(<MotionPage {...props} tab="positions" />);
    expect(scene).not.toBeVisible(); expect(screen.getByText("Saved poses")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "动作组" }));
    expect(onTabChange).toHaveBeenCalledWith("groups");
    rerender(<MotionPage {...props} tab="groups" />);
    expect(scene).not.toBeVisible(); expect(screen.getByText("Action timeline")).toBeVisible();
    expect(screen.getByText("Saved poses")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "收起 Controllers" }));
    expect(onToggleControllers).toHaveBeenCalledOnce();
    rerender(<MotionPage {...props} active={false} controllersOpen={false} />);
    expect(scene).not.toBeVisible();
    rerender(<MotionPage {...props} controllersOpen={false} />);
    expect(screen.getByTestId("scene")).toBe(scene); expect(scene).toBeVisible();
    expect(screen.getByText("Controller operations")).not.toBeVisible();
    expect(screen.getByText("Shared motion log")).toBeVisible();
  });
});

function ReportPublisher({ state }: { state?: PositionMotionState }) {
  const open = useMotionReport(state, null);
  return <button onClick={open}>查看执行报告</button>;
}
const reportState: PositionMotionState = { commandId: "group-1", label: "取放", phase: "succeeded", message: "Action 成功，已停稳", group: { id: "group", count: 2, index: 1, phase: "holding", elapsed: 15 } };
it("keeps output selection and editor mounted on completion, opens reports explicitly and clears prior profile results", async () => {
  const user = userEvent.setup();
  const props = { active: true, tab: "groups" as const, onTabChange: vi.fn(), controllersOpen: false,
    onToggleControllers: vi.fn(), controllers: null, readiness: null,
    robot: null, positions: null, log: <MotionTerminal active logs={[]} /> };
  const view = render(<MotionPage {...props} groups={<ReportPublisher />} />);
  const editor = screen.getByRole("button", { name: "查看执行报告" });
  await user.click(screen.getByRole("button", { name: "收起执行面板" }));
  view.rerender(<MotionPage {...props} groups={<ReportPublisher state={reportState} />} />);
  expect(screen.getByRole("tab", { name: "执行日志" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "展开执行面板" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("status", { name: "最近动作组执行结果" })).not.toBeInTheDocument();
  await user.click(editor);
  expect(screen.getByRole("tab", { name: "执行报告" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("status", { name: "最近动作组执行结果" })).toHaveTextContent("Action 成功，已停稳");
  view.rerender(<MotionPage {...props} active={false} groups={<ReportPublisher state={reportState} />} />);
  view.rerender(<MotionPage {...props} groups={<ReportPublisher state={reportState} />} />);
  expect(screen.getByRole("button", { name: "查看执行报告" })).toBe(editor);
  expect(screen.getByRole("status", { name: "最近动作组执行结果" })).toHaveTextContent("取放");
  view.rerender(<MotionPage {...props} groups={<ReportPublisher key="new-profile" />} />);
  expect(screen.queryByRole("status", { name: "最近动作组执行结果" })).not.toBeInTheDocument();
  expect(screen.getByText(/暂无动作组执行报告/)).toBeVisible();
});
it("preserves log filters and scroll while reports are open, and pauses the retained raw reader when hidden or folded", async () => {
  const user = userEvent.setup();
  const props = { active: true, tab: "groups" as const, onTabChange: vi.fn(), controllersOpen: false,
    onToggleControllers: vi.fn(), controllers: null, readiness: null, robot: null, positions: null,
    log: <MotionTerminal active logs={[]} plannerLog={active => <div data-testid="raw-reader" data-active={active}>raw planner</div>} /> };
  render(<MotionPage {...props} />);
  const search = screen.getByRole("searchbox");
  await user.type(search, "timeout");
  const pre = screen.getByLabelText("规划日志输出");
  Object.defineProperties(pre, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  fireEvent.wheel(pre); fireEvent.scroll(pre);
  pre.scrollTop = 123;
  await user.click(screen.getByRole("tab", { name: "执行报告" }));
  await user.click(screen.getByRole("tab", { name: "执行日志" }));
  expect(screen.getByRole("searchbox")).toBe(search);
  expect(search).toHaveValue("timeout");
  expect(pre.scrollTop).toBe(123);
  await user.selectOptions(screen.getByLabelText("规划日志来源"), "moveit");
  const raw = screen.getByTestId("raw-reader");
  expect(raw).toHaveAttribute("data-active", "true");
  await user.click(screen.getByRole("tab", { name: "执行报告" }));
  expect(raw).toHaveAttribute("data-active", "false");
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("tab", { name: "执行日志" })).toHaveFocus();
  expect(screen.getByTestId("raw-reader")).toBe(raw);
  expect(raw).toHaveAttribute("data-active", "true");
  await user.click(screen.getByRole("button", { name: "收起执行面板" }));
  expect(raw).toHaveAttribute("data-active", "false");
  await user.click(screen.getByRole("button", { name: "展开执行面板" }));
  expect(raw).toHaveAttribute("data-active", "true");
});


it("starts compact output folded, preserves the scene in focus and allows report access to exit focus",async()=>{
  localStorage.clear();const user=userEvent.setup(),exit=vi.fn();
  const props={active:true,compact:true,tab:'robot' as const,onTabChange:vi.fn(),controllersOpen:true,onToggleControllers:vi.fn(),controllers:<div>control body</div>,readiness:<span>health details</span>,robot:<div data-testid="focus-scene"/>,positions:null,log:<div>live log body</div>,onToggleFocus:exit};
  const view=render(<MotionPage {...props}/>);const scene=screen.getByTestId('focus-scene');
  expect(screen.getByRole('button',{name:'展开执行面板'})).toBeVisible();expect(screen.getByText('live log body')).not.toBeVisible();
  await user.click(screen.getByRole('tab',{name:'执行日志'}));expect(screen.getByText('live log body')).toBeVisible();
  view.rerender(<MotionPage {...props} focusMode/>);expect(screen.getByText('live log body')).not.toBeVisible();expect(screen.getByText('control body')).not.toBeVisible();expect(screen.getByTestId('focus-scene')).toBe(scene);
  await user.click(screen.getByRole('tab',{name:'执行报告'}));expect(exit).toHaveBeenCalledOnce();
  view.rerender(<MotionPage {...props}/>);expect(screen.getByText('control body')).toBeVisible();
});

it("opens URDF alongside Robot View without exposing the robot controls", async () => {
  const change = vi.fn();
  const props = { active: true, tab: "robot" as const, onTabChange: change, controllersOpen: false, onToggleControllers: vi.fn(), controllers: null, readiness: null, robot: <div>Robot control view</div>, urdf: <div>Model inspection</div>, positions: null, log: null };
  const view = render(<MotionPage {...props}/>);
  await userEvent.click(screen.getByRole("tab", {name: "URDF"}));
  expect(change).toHaveBeenCalledWith("urdf");
  view.rerender(<MotionPage {...props} tab="urdf"/>);
  expect(screen.getByText("Model inspection")).toBeVisible();
  expect(screen.getByText("Robot control view")).not.toBeVisible();
});

it("retains visible editing controls when only drawing is suspended", async () => {
  const change = vi.fn(), user = userEvent.setup();
  const props = {active:false, visible:true, tab:"positions" as const, onTabChange:change, controllersOpen:false,
    onToggleControllers:vi.fn(), controllers:null, readiness:null, robot:null, positions:<input aria-label="Draft" defaultValue="retained" />, groups:null, log:null};
  const view = render(<MotionPage {...props} />);
  expect(screen.getByLabelText("Draft")).toBeVisible();
  await user.click(screen.getByRole("tab", {name:"动作组"})); expect(change).toHaveBeenCalledWith("groups");
  view.rerender(<MotionPage {...props} visible={false} />); expect(screen.getByLabelText("Draft")).not.toBeVisible();
});
