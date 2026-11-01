import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MotionPage } from "./MotionPage";

describe("Motion workspace", () => {
  it("preserves the scene across tabs/navigation with independent controller visibility", async () => {
    const onTabChange = vi.fn(), onToggleControllers = vi.fn();
    const props = { active: true, tab: "robot" as "robot" | "positions", onTabChange,
      controllersOpen: true, onToggleControllers, controllers: <div>Controller operations</div>,
      readiness: <span>等待新鲜反馈</span>, robot: <div data-testid="scene">Retained scene</div>,
      positions: <div>Saved poses</div>, log: <div>Shared motion log</div> };
    const user = userEvent.setup(); const { rerender } = render(<MotionPage {...props} />);
    const scene = screen.getByTestId("scene");
    await user.click(screen.getByRole("tab", { name: "位置" }));
    expect(onTabChange).toHaveBeenCalledWith("positions");
    rerender(<MotionPage {...props} tab="positions" />);
    expect(scene).not.toBeVisible(); expect(screen.getByText("Saved poses")).toBeVisible();
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
