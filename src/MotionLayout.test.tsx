import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MotionDivider, MotionLayoutProvider } from "./MotionLayout";
import { defaultMotionLayout, MOTION_LAYOUT_KEY } from "./motionLayoutLogic";
import { ViewerHeadsUp } from "./ViewerHeadsUp";

function Workspace({ active = true, resetVersion = 0 }: { active?: boolean; resetVersion?: number }) {
  return <MotionLayoutProvider active={active} resetVersion={resetVersion}><div className="host"><div className="panel" />
    <MotionDivider size="controllersWidth" label="width" axis="x" panel=".panel" container=".host" />
    <MotionDivider size="logHeight" label="height" axis="y" edge="end" panel=".panel" container=".host" />
  </div></MotionLayoutProvider>;
}
const saved = () => JSON.parse(localStorage.getItem(MOTION_LAYOUT_KEY)!);
beforeEach(() => localStorage.clear());
describe("Motion dividers", () => {
  it("supports keyboard increments, end bounds, defaults and persistence", () => {
    const { rerender } = render(<Workspace />);
    const width = screen.getByRole("separator", { name: "width" });
    fireEvent.keyDown(width, { key: "ArrowRight" }); expect(saved().controllersWidth).toBe(290);
    fireEvent.keyDown(width, { key: "ArrowLeft", shiftKey: true }); expect(saved().controllersWidth).toBe(250);
    fireEvent.keyDown(width, { key: "End" }); expect(saved().controllersWidth).toBe(520);
    fireEvent.keyDown(width, { key: "Home" }); expect(saved().controllersWidth).toBe(180);
    fireEvent.doubleClick(width); expect(saved().controllersWidth).toBe(280);
    fireEvent.keyDown(screen.getByRole("separator", { name: "height" }), { key: "ArrowUp" }); expect(saved().logHeight).toBe(200);
    rerender(<Workspace resetVersion={1} />); expect(saved()).toEqual(defaultMotionLayout);
  });
  it("restores saved values without resetting on mount and tolerates failed writes", () => {
    localStorage.setItem(MOTION_LAYOUT_KEY, JSON.stringify({ controlsWidth: 400, controllersWidth: 350 }));
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw Error("denied"); });
    render(<Workspace resetVersion={3} />);
    expect(screen.getByRole("separator", { name: "width" })).toHaveAttribute("aria-valuenow", "350");
    fireEvent.keyDown(screen.getByRole("separator", { name: "width" }), { key: "ArrowRight" });
    expect(screen.getByRole("separator", { name: "width" })).toHaveAttribute("aria-valuenow", "360"); spy.mockRestore();
  });
  it("measures actual panels, clamps pointer movement and cleans up on hide/unmount", () => {
    // jsdom has no PointerEvent; retain its pointer fields for the production event path.
    vi.stubGlobal("PointerEvent", MouseEvent);
    const { container, rerender, unmount } = render(<Workspace />);
    const host = container.querySelector(".host")!, panel = container.querySelector(".panel")!;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ width: 600, height: 500 } as DOMRect);
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 200, height: 150 } as DOMRect);
    const width = screen.getByRole("separator", { name: "width" });
    fireEvent.pointerDown(width, { button: 0, clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 350 }); expect(saved().controllersWidth).toBe(350);
    fireEvent.pointerMove(window, { clientX: 900 }); expect(saved().controllersWidth).toBe(420);
    fireEvent.pointerUp(window); expect(document.body).not.toHaveClass("resizing-panels");
    fireEvent.pointerMove(window, { clientX: 250 }); expect(saved().controllersWidth).toBe(420);
    fireEvent.pointerDown(width, { button: 0, clientX: 200 });
    rerender(<Workspace active={false} />); expect(document.body).not.toHaveClass("resizing-panels");
    rerender(<Workspace />); fireEvent.pointerDown(screen.getByRole("separator", { name: "height" }), { button: 0, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 50 }); expect(saved().logHeight).toBe(200);
    unmount(); expect(document.body.style.cursor).toBe(""); vi.unstubAllGlobals();
  });
  it("keeps Robot View floating tools inside Motion", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    render(<MotionLayoutProvider active><ViewerHeadsUp error="resource error" leading={<span>motion state</span>} rgbd={<span>RGBD options</span>}><span>TCP options</span></ViewerHeadsUp></MotionLayoutProvider>);
    expect(screen.getByLabelText("运动状态面板")).toHaveTextContent("resource error");
    expect(screen.getByLabelText("Robot View 操作面板")).toHaveTextContent("TCP options");
    expect(screen.getByLabelText("RGBD 面板")).toHaveTextContent("RGBD options");
    expect(screen.getByRole("button", { name: "调整时钟同步 / RGBD浮窗大小" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
