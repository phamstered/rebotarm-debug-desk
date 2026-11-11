import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativePageToolbar, NativeWorkspaceHost } from "./NativeWorkspace";
const mocks = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => { mocks.invoke.mockClear(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows the matching window operation and blocks migration during sampling", async () => {
  const user = userEvent.setup(); const onAction = vi.fn();
  const props = { page: "handeye" as const, connected: true, onAction, busyReason: "", state: { detached: false, visible: true, ready: true, busy_reason: "" } };
  const { rerender } = render(<NativePageToolbar {...props} />);
  await user.click(screen.getByRole("button", { name: "拆出窗口 ↗" }));
  expect(onAction).toHaveBeenCalledWith("workspace_detach", "handeye");
  rerender(<NativePageToolbar {...props} busyReason="正在采样" state={{ ...props.state, detached: true }} />);
  expect(screen.getByRole("button", { name: "收回主窗口" })).toBeDisabled();
  rerender(<NativePageToolbar {...props} state={{ ...props.state, detached: true }} />);
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
