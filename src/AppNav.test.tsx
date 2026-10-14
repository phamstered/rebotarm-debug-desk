import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppNav } from "./AppNav";

describe("AppNav", () => {
  it("highlights the active page and switches to Monitor", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    const { rerender } = render(
      <AppNav page="dashboard" expanded onSelect={onSelect} onToggle={onToggle} />,
    );
    expect(screen.getByRole("navigation", { name: "主工具栏" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Monitor" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "Monitor" }));
    expect(onSelect).toHaveBeenCalledWith("monitor");

    rerender(<AppNav page="monitor" expanded onSelect={onSelect} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Monitor" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Dashboard" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("button", { name: "完全收起主工具栏" }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("hides the collapse control when the nav is already collapsed", () => {
    render(<AppNav page="motor" expanded={false} onSelect={() => undefined} onToggle={() => undefined} />);
    expect(screen.queryByRole("button", { name: "完全收起主工具栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Motor" })).toHaveAttribute("aria-current", "page");
  });
});
