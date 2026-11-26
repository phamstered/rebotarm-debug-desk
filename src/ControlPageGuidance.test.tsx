import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ControlPageGuidance } from "./ControlPageGuidance";
import { NativePageActionsContext } from "./NativePageActions";
import { openTerminal } from "./terminalLogLogic";

vi.mock("./terminalLogLogic", async original => ({ ...await original<typeof import("./terminalLogLogic")>(), openTerminal: vi.fn() }));

it("keeps all general guidance behind a keyboard-accessible single toggle", async () => {
  const user = userEvent.setup();
  render(<ControlPageGuidance />);
  const toggle = screen.getByRole("button", { name: "操作说明" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText(/停用 Controller 会保留加载状态/)).not.toBeVisible();
  toggle.focus();
  await user.keyboard("{Enter}");
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText(/停用 Controller 会保留加载状态/)).toBeVisible();
  expect(screen.getByText(/安全停止旧模式/)).toBeVisible();
  expect(screen.getByText(/直接关闭输出不回零/)).toBeVisible();
  await user.keyboard("{Enter}");
  expect(screen.getByText(/直接关闭输出不回零/)).not.toBeVisible();
});

it("opens all sources in a detached control window instead of filtering away task or ROS records", async () => {
  const user = userEvent.setup();
  render(<NativePageActionsContext.Provider value={{page:"control", state:{detached:true} as any, connected:true, busyReason:"", onAction:vi.fn()}}>
    <ControlPageGuidance />
  </NativePageActionsContext.Provider>);
  await user.click(screen.getByRole("button", {name:"查看日志"}));
  expect(openTerminal).toHaveBeenLastCalledWith(undefined, undefined, "control");
});
