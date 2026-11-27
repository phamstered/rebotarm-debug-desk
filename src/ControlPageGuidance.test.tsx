import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ControlPageGuidance } from "./ControlPageGuidance";

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

it("leaves log access in the bottom Terminal instead of adding page-local entries", () => {
 render(<ControlPageGuidance/>);
 expect(screen.queryByRole("button",{name:"查看日志"})).not.toBeInTheDocument();
 expect(screen.getAllByRole("button")).toHaveLength(1);
});
