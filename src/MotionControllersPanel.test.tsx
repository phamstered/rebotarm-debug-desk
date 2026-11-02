import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { MotionControllersPanel } from "./MotionControllersPanel";
const controller = { name: "arm", state: "inactive", typeName: "test/Controller" };
const props = { status: { manager: "/controller_manager", fresh: true, available: true, message: "", controllers: [controller] }, refreshing: false, onRefresh: vi.fn(), onSwitch: vi.fn(), action: null, message: "", error: "", disabledReason: "", onInspect: vi.fn() };
it("requires explicit confirmation and rechecks changed controller state before confirming", async () => {
  const user = userEvent.setup(), change = vi.fn();
  const view = render(<MotionControllersPanel {...props} onSwitch={change} />);
  await user.click(screen.getByRole("button", { name: "激活 arm" }));
  expect(screen.getByRole("dialog")).toBeVisible(); expect(change).not.toHaveBeenCalled();
  view.rerender(<MotionControllersPanel {...props} onSwitch={change} status={{ ...props.status, controllers: [{ ...controller, state: "unconfigured" }] }} />);
  expect(screen.getByRole("button", { name: "确认激活" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "取消" }));
  view.rerender(<MotionControllersPanel {...props} onSwitch={change} />);
  await user.click(screen.getByRole("button", { name: "激活 arm" }));
  await user.click(screen.getByRole("button", { name: "确认激活" }));
  expect(change).toHaveBeenCalledExactlyOnceWith(controller, "activate");
});
it("locks switching during operations, refresh, disconnection and unknown states while retaining Graph navigation", async () => {
  const user = userEvent.setup();
  const view = render(<MotionControllersPanel {...props} refreshing />);
  expect(screen.getByRole("button", { name: "激活 arm" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "查看 arm Graph" }));
  expect(props.onInspect).toHaveBeenCalledWith("arm");
  for (const patch of [{ disabledReason: "运动进行中" }, { action: { name: "other", action: "deactivate" as const } }, { status: { ...props.status, available: false } }, { status: { ...props.status, controllers: [{ ...controller, state: "unknown" }] } }]) {
    view.rerender(<MotionControllersPanel {...props} {...patch} />);
    expect(screen.getByRole("button", { name: "激活 arm" })).toBeDisabled();
  }
});
it("confirms active controller deactivation and can cancel with Escape", async () => {
  const user = userEvent.setup(), change = vi.fn();
  const active = { ...controller, state: "active" };
  render(<MotionControllersPanel {...props} onSwitch={change} status={{ ...props.status, controllers: [active] }} />);
  await user.click(screen.getByRole("button", { name: "停用 arm" })); await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(change).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "停用 arm" })); await user.click(screen.getByRole("button", { name: "确认停用" }));
  expect(change).toHaveBeenCalledExactlyOnceWith(active, "deactivate");
});
it("discards pending confirmation when its page or panel becomes inactive", async () => {
  const user = userEvent.setup(), change = vi.fn();
  const view = render(<MotionControllersPanel {...props} onSwitch={change} />);
  await user.click(screen.getByRole("button", { name: "激活 arm" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  view.rerender(<MotionControllersPanel {...props} onSwitch={change} active={false} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(<MotionControllersPanel {...props} onSwitch={change} active />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
});
it("disables an open confirmation immediately when its snapshot expires",async()=>{
  const user=userEvent.setup(),change=vi.fn();const view=render(<MotionControllersPanel {...props} onSwitch={change}/>);
  await user.click(screen.getByRole("button",{name:"激活 arm"}));
  view.rerender(<MotionControllersPanel {...props} onSwitch={change} status={{...props.status,available:false,fresh:false,hasSnapshot:true,snapshotAgeMs:3100,queryState:"stale",message:"Controller 快照已过期"}}/>);
  expect(screen.getByRole("button",{name:"确认激活"})).toBeDisabled();
  expect(screen.getByRole("button",{name:"激活 arm"})).toBeDisabled();expect(change).not.toHaveBeenCalled();
});
