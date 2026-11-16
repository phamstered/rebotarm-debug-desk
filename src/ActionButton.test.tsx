import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ActionButton, IconButton } from "./ActionButton";

it("names icon-only actions and preserves keyboard activation without submitting the surrounding form", async () => {
  const user = userEvent.setup();
  const refresh = vi.fn(), submit = vi.fn(e => e.preventDefault());
  const ref = createRef<HTMLButtonElement>();
  render(<form onSubmit={submit}><IconButton ref={ref} icon="refresh" label="刷新 Controllers" title="重新查询控制器状态" onClick={refresh} /><ActionButton type="submit">保存配置</ActionButton></form>);
  const button = screen.getByRole("button", { name: "刷新 Controllers" });
  expect(button).toHaveTextContent("");
  expect(button).toHaveAttribute("title", "刷新 Controllers · 重新查询控制器状态");
  expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(ref.current).toBe(button);
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  await user.tab();
  await user.keyboard("{Enter}");
  expect(submit).toHaveBeenCalledTimes(1);
});

it("keeps disabled and busy actions inert and reports busy state until the owner clears it", async () => {
  const user = userEvent.setup(), run = vi.fn();
  const view = render(<IconButton icon="download" label="导出日志" disabled title="请先连接机器人" onClick={run} />);
  const button = screen.getByRole("button", { name: "导出日志" });
  expect(button).toHaveAttribute("title", "导出日志 · 请先连接机器人");
  await user.click(button);
  view.rerender(<IconButton icon="download" label="导出日志" busy onClick={run} />);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAttribute("title", "导出日志（处理中…）");
  await user.click(button);
  expect(run).not.toHaveBeenCalled();
  view.rerender(<IconButton icon="download" label="导出日志" onClick={run} />);
  expect(button).toBeEnabled();
  await user.click(button);
  expect(run).toHaveBeenCalledTimes(1);
});

it("preserves toggle state, descriptions, native form targeting and safety-action text", () => {
  render(<><p id="lock-reason">现场确认后才能运行</p><IconButton icon="lock" label="锁定布局" aria-pressed aria-describedby="lock-reason" /><ActionButton type="submit" form="pose-form" className="danger" disabled>停止并 DISABLE</ActionButton></>);
  expect(screen.getByRole("button", { name: "锁定布局" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "锁定布局" })).toHaveAccessibleDescription("现场确认后才能运行");
  const stop = screen.getByRole("button", { name: "停止并 DISABLE" });
  expect(stop).toHaveTextContent("停止并 DISABLE");
  expect(stop).toHaveAttribute("form", "pose-form");
  expect(stop).toHaveClass("danger");
  expect(stop).toBeDisabled();
});
