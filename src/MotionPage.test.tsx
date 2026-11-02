import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
    await user.click(screen.getByRole("button", { name: /规划执行日志/ }));
    expect(screen.queryByRole("searchbox", { name: "搜索规划日志" })).not.toBeInTheDocument();
    rerender(<MotionPage {...props} resetVersion={1} />);
    expect(screen.getByRole("searchbox", { name: "搜索规划日志" })).toBeVisible();
    expect(JSON.parse(localStorage.getItem(MOTION_LAYOUT_KEY)!)).toEqual(defaultMotionLayout);
    expect(screen.getByTestId("retained-model")).toBe(scene);
  });
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
