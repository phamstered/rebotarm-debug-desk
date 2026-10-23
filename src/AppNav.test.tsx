import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppNav } from "./AppNav";

describe("AppNav", () => {
  it("places Status first and highlights the active page", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { rerender } = render(
      <AppNav page="dashboard" expanded rosReady onSelect={onSelect} onToggle={onToggle} />,
    );
    expect(screen.getByRole("navigation", { name: "主工具栏" })).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "主工具栏" });
    const navButtons = Array.from(nav.querySelectorAll(".app-nav-items .app-nav-item > button"));
    expect(navButtons[0]).toHaveTextContent("Status");
    expect(screen.getByRole("button", { name: "Topics" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Status" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "Status" }));
    expect(onSelect).toHaveBeenCalledWith("status");

    rerender(<AppNav page="status" expanded rosReady onSelect={onSelect} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Status" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Topics" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "Monitor" }));
    expect(onSelect).toHaveBeenCalledWith("monitor");

    await user.click(screen.getByRole("button", { name: "数据采集" }));
    expect(onSelect).toHaveBeenCalledWith("collection");

    await user.click(screen.getByRole("button", { name: "完全收起主工具栏" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("hides the collapse control when the nav is already collapsed", () => {
    render(<AppNav page="motor" expanded={false} rosReady onSelect={() => undefined} onToggle={() => undefined} />);
    expect(screen.queryByRole("button", { name: "完全收起主工具栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Motor" })).toHaveAttribute("aria-current", "page");
  });

  it("disables Monitor and Motor until ROS ready and explains why", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AppNav page="status" expanded rosReady={false} onSelect={onSelect} onToggle={() => undefined} />);
    expect(screen.getByRole("button", { name: "Monitor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Motor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Monitor" }).getAttribute("title")).toContain("JointState");
    expect(screen.getByTestId("nav-disabled-monitor")).toHaveTextContent("JointState");
    expect(screen.getByTestId("nav-disabled-motor")).toHaveTextContent("电机控制");
    await user.click(screen.getByRole("button", { name: "Monitor" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Topics" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "数据采集" })).not.toBeDisabled();
  });

  it("gates 重力辨识 until ROS ready and can select when ready", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <AppNav page="status" expanded rosReady={false} onSelect={onSelect} onToggle={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "重力辨识" })).toBeDisabled();
    expect(screen.getByTestId("nav-disabled-gravity")).toHaveTextContent("重力辨识");
    rerender(<AppNav page="status" expanded rosReady onSelect={onSelect} onToggle={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "重力辨识" }));
    expect(onSelect).toHaveBeenCalledWith("gravity");
  });
});
