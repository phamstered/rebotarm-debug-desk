import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeWorkspaceHost, NativeOfflineWorkspace } from "./NativeWorkspace";
import { NativePageActions, NativePageActionsContext, type NativePageActionsState } from "./NativePageActions";
function Actions(props: NativePageActionsState) { return <NativePageActionsContext.Provider value={props}><NativePageActions /></NativePageActionsContext.Provider>; }
const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue({}); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("reopens retained offline pages through the same native host without starting a connection", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn(), onConnection = vi.fn(), onDismissError = vi.fn();
  const ready = { ready: true, detached: false, visible: true, busy_reason: "" };
  render(<NativeOfflineWorkspace page="monitor" snapshot={{ selected: "monitor", pages: {
    monitor: ready, handeye: { ...ready, detached: true }, motor: { ...ready, ready: false },
  } }} onSelect={onSelect} onConnection={onConnection} onError={vi.fn()} error="窗口错误" onDismissError={onDismissError} />);
  expect(screen.getByRole("combobox", { name: "已打开页面" })).toHaveValue("monitor");
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_select", { page: "monitor" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "已打开页面" }), "handeye");
  expect(onSelect).toHaveBeenCalledWith("handeye");
  await user.click(screen.getByRole("button", { name: "关闭提示" }));
  expect(onDismissError).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "返回连接" }));
  expect(onConnection).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls.every(([command]) => command.startsWith("workspace_"))).toBe(true);
});
it("shows the matching window operation and blocks migration during sampling", async () => {
  const user = userEvent.setup(); const onAction = vi.fn();
  const props = { page: "handeye" as const, connected: true, onAction, busyReason: "", state: { detached: false, visible: true, ready: true, busy_reason: "" } };
  const { rerender } = render(<Actions {...props} />);
  await user.click(screen.getByRole("button", { name: "拆出窗口" }));
  expect(onAction).toHaveBeenCalledWith("workspace_detach", "handeye");
  rerender(<Actions {...props} busyReason="正在采样" state={{ ...props.state, detached: true }} />);
  expect(screen.getByRole("button", { name: "收回主窗口" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "显示主窗口" }));
  expect(onAction).toHaveBeenLastCalledWith("workspace_show_main", "handeye");
  rerender(<Actions {...props} state={{ ...props.state, detached: true }} />);
  await user.click(screen.getByRole("button", { name: "收回主窗口" }));
  expect(onAction).toHaveBeenLastCalledWith("workspace_dock", "handeye");
});
it("hides native pages for root modals without refocusing a detached window, and covers on unmount", async () => {
  const props = { page: "handeye" as const, snapshot: { selected: "handeye" as const, pages: {} }, covered: false, onError: vi.fn() };
  const { rerender, unmount } = render(<NativeWorkspaceHost {...props} />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_select", { page: "handeye" }));
  mocks.invoke.mockClear(); rerender(<NativeWorkspaceHost {...props} covered />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("workspace_cover", { covered: true }));
  expect(mocks.invoke).not.toHaveBeenCalledWith("workspace_select", expect.anything());
  unmount(); expect(mocks.invoke).toHaveBeenLastCalledWith("workspace_cover", { covered: true });
});
it("offers recovery after an incomplete rollback while keeping sampling migration gates", async () => {
  const user=userEvent.setup(); const onAction=vi.fn();
  const props={page:"handeye" as const, connected:false, busyReason:"", onAction, state:{detached:true,visible:true,ready:true,busy_reason:"",recovery_required:true}};
  const {rerender}=render(<Actions {...props}/>);
  expect(screen.queryByRole("button",{name:"收回主窗口"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"恢复窗口"}));
  expect(onAction).toHaveBeenCalledWith("workspace_recover","handeye");
  rerender(<Actions {...props} busyReason="正在采样"/>);
  expect(screen.getByRole("button",{name:"恢复窗口"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"显示主窗口"})).toBeEnabled();
});
it("offers recovery in the main placeholder even if the failed page was originally embedded", async () => {
  const user=userEvent.setup(); const onError=vi.fn();
  render(<NativeWorkspaceHost page="handeye" covered={false} onError={onError} snapshot={{selected:"handeye",pages:{handeye:{detached:false,visible:true,ready:true,busy_reason:"",recovery_required:true}}}}/>);
  expect(screen.getByRole("alert")).toHaveTextContent("窗口需要恢复");
  mocks.invoke.mockImplementation(async(command:string)=>{if(command==="workspace_recover") throw new Error("恢复失败");return {};});
  await user.click(screen.getByRole("button",{name:"恢复窗口"}));
  expect(mocks.invoke).toHaveBeenCalledWith("workspace_recover",{page:"handeye"});
  await waitFor(()=>expect(onError).toHaveBeenCalledWith("Error: 恢复失败"));
});
it("keeps deferred startup layout visible with a guarded manual retry", async () => {
  const onAction = vi.fn();
  const props = { page: "motion" as const, connected: false, onAction, busyReason: "", state: {
    ready: true, detached: false, visible: true, busy_reason: "",
    restore_pending: "等待恢复独立窗口：原任务尚未确认结束",
  } };
  const { rerender } = render(<Actions {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent("等待恢复独立窗口");
  await userEvent.click(screen.getByRole("button", { name: "拆出窗口" }));
  expect(onAction).toHaveBeenCalledWith("workspace_detach", "motion");
  rerender(<Actions {...props} busyReason="正在采样" />);
  expect(screen.getByRole("button", { name: "拆出窗口" })).toBeDisabled();
  rerender(<Actions {...props} state={{ ...props.state, detached: true, restore_pending: "" }} />);
  expect(screen.queryByText(/等待恢复独立窗口/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收回主窗口" })).toBeEnabled();
});

it("keeps embedded chrome icon-only and exposes connection details with keyboard dismissal only when standalone", async () => {
  const user = userEvent.setup();
  const props = { page: "status" as const, connected: true, profileName: "robot-fixture", busyReason: "", onAction: vi.fn(), state: { ready: true, detached: false, visible: true, busy_reason: "" } };
  const { rerender } = render(<Actions {...props} />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "拆出窗口" })).toHaveTextContent("");
  expect(screen.queryByText("robot-fixture")).toBeNull();
  rerender(<Actions {...props} state={{ ...props.state, detached: true }} />);
  expect(screen.getAllByRole("button")).toHaveLength(3);
  await user.click(screen.getByRole("button", { name: "连接详情" }));
  expect(screen.getByRole("region", { name: "连接详情" })).toHaveTextContent("robot-fixture");
  expect(screen.getByRole("region", { name: "连接详情" })).toHaveTextContent("共享连接已就绪");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "连接详情" })).toBeNull();
  expect(screen.getByRole("button", { name: "连接详情" })).toHaveFocus();
  rerender(<Actions {...props} connected={false} state={{ ...props.state, detached: true }} />);
  expect(screen.getByRole("status")).toHaveTextContent("连接已断开");
});

it("keeps blocked migration reasons keyboard accessible and prevents duplicate pending requests", async () => {
  const user = userEvent.setup(); let finish!: () => void;
  const onAction = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { page: "handeye" as const, connected: true, busyReason: "正在保存样本", onAction, state: { ready: true, detached: false, visible: true, busy_reason: "" } };
  const { rerender } = render(<Actions {...props} />);
  await user.tab();
  expect(document.activeElement).toHaveAccessibleName("拆出窗口不可用：正在保存样本");
  await user.keyboard("{Enter}");
  expect(onAction).not.toHaveBeenCalled();
  rerender(<Actions {...props} busyReason="" />);
  await user.click(screen.getByRole("button", { name: "拆出窗口" }));
  expect(screen.getByRole("button", { name: "拆出窗口" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "拆出窗口" }));
  expect(onAction).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "拆出窗口" })).toBeEnabled());
});

it("shows migration failure without replacing the page or hiding recovery actions", async () => {
  const props = { page: "status" as const, connected: true, busyReason: "", onAction: vi.fn().mockRejectedValue(new Error("窗口移动失败")), state: { ready: true, detached: false, visible: true, busy_reason: "" } };
  render(<Actions {...props} />);
  await userEvent.click(screen.getByRole("button", { name: "拆出窗口" }));
  expect(await screen.findByRole("status")).toHaveTextContent("窗口移动失败");
  expect(screen.getByRole("button", { name: "拆出窗口" })).toBeEnabled();
});
