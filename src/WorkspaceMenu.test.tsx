import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceMenu, WorkspacePopover } from "./WorkspaceMenu";
import { readWorkspacePreference } from "./workspacePreferences";

function Target({ run, active = true }: { run(): void; active?: boolean }) {
  const menu = useWorkspaceMenu(
    [
      { label: "编辑", run },
      { label: "不可操作", run, disabled: true },
      { label: "删除", danger: true, run },
    ],
    "测试对象",
    active,
  );
  return (
    <>
      <div
        data-testid="target"
        tabIndex={0}
        onContextMenu={menu.onContextMenu}
        onKeyDown={menu.onKeyDown}
      >
        <input aria-label="编辑字段" />
      </div>
      {menu.trigger}
      {menu.menu}
    </>
  );
}
afterEach(() => vi.restoreAllMocks());
it("supports right click, keyboard navigation, disabled items and Escape focus restoration", async () => {
  const user = userEvent.setup(),
    run = vi.fn();
  render(<Target run={run} />);
  const target = screen.getByTestId("target");
  target.focus();
  fireEvent.contextMenu(target, { clientX: 100, clientY: 100 });
  expect(screen.getByRole("menuitem", { name: "编辑" })).toHaveFocus();
  expect(screen.getByRole("menuitem", { name: "不可操作" })).toBeDisabled();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "删除" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(target).toHaveFocus();
  expect(run).not.toHaveBeenCalled();
  await user.keyboard("{Shift>}{F10}{/Shift}");
  await user.click(screen.getByRole("menuitem", { name: "编辑" }));
  expect(run).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
it("uses current callbacks, leaves text editing alone and dismisses on hide/outside click", async () => {
  const user = userEvent.setup(),
    old = vi.fn(),
    next = vi.fn();
  const view = render(<Target run={old} />);
  fireEvent.contextMenu(screen.getByLabelText("编辑字段"));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "测试对象菜单" }));
  view.rerender(<Target run={next} />);
  await user.click(screen.getByRole("menuitem", { name: "编辑" }));
  expect(next).toHaveBeenCalledOnce();
  expect(old).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "测试对象菜单" }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "测试对象菜单" }));
  view.rerender(<Target run={next} active={false} />);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});
it("clamps the menu within the viewport and keeps popover tools available through keyboard", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 200,
    height: 150,
    left: 0,
    top: 0,
    bottom: 150,
    right: 200,
    x: 0,
    y: 0,
    toJSON: () => {},
  });
  const user = userEvent.setup();
  render(
    <>
      <Target run={vi.fn()} />
      <WorkspacePopover label="更多工具">
        <button>刷新</button>
      </WorkspacePopover>
    </>,
  );
  fireEvent.contextMenu(screen.getByTestId("target"), {
    clientX: innerWidth - 1,
    clientY: innerHeight - 1,
  });
  const menu = screen.getByRole("menu");
  expect(parseFloat(menu.style.left)).toBe(innerWidth - 208);
  expect(parseFloat(menu.style.top)).toBe(innerHeight - 158);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "更多工具" }));
  expect(screen.getByRole("button", { name: "刷新" })).toBeVisible();
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("button", { name: "刷新" }),
  ).not.toBeInTheDocument();
});
it("rejects malformed and unknown workspace preferences", () => {
  localStorage.clear();
  localStorage.setItem("robot-console-workspace-test", '"unknown"');
  expect(readWorkspacePreference("test", "split", ["split", "timeline"])).toBe(
    "split",
  );
  localStorage.setItem("robot-console-workspace-test", "broken");
  expect(readWorkspacePreference("test", false)).toBe(false);
  localStorage.setItem("robot-console-workspace-test", "true");
  expect(readWorkspacePreference("test", false)).toBe(true);
});

it("portals tool popovers outside clipped editors and dismisses them when their page hides", async () => {
  const user = userEvent.setup();
  const make = (active: boolean) => (
    <div style={{ overflow: "hidden", height: 20 }}>
      <WorkspacePopover label="添加与轨道" active={active}>
        <button>添加 Pose</button>
      </WorkspacePopover>
    </div>
  );
  const view = render(make(true));
  await user.click(screen.getByRole("button", { name: "添加与轨道" }));
  expect(screen.getByRole("region", { name: "添加与轨道" }).parentElement).toBe(
    document.body,
  );
  await user.click(screen.getByRole("button", { name: "添加 Pose" }));
  await user.keyboard("{Escape}");
  expect(
    screen.queryByRole("region", { name: "添加与轨道" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "添加与轨道" }));
  view.rerender(make(false));
  expect(
    screen.queryByRole("region", { name: "添加与轨道" }),
  ).not.toBeInTheDocument();
});

it("closes a mouse-opened popover when focus stays on the body, while respecting handled Escape", async () => {
  const user=userEvent.setup();
  render(<WorkspacePopover label="工具"><button>刷新</button></WorkspacePopover>);
  const trigger=screen.getByRole("button",{name:"工具"});
  await user.click(trigger);trigger.blur();
  expect(document.activeElement).toBe(document.body);
  const handled=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});
  handled.preventDefault();document.dispatchEvent(handled);
  expect(screen.getByRole("region",{name:"工具"})).toBeVisible();
  fireEvent.keyDown(document.body,{key:"Escape",isComposing:true});
  expect(screen.getByRole("region",{name:"工具"})).toBeVisible();
  fireEvent.keyDown(document.body,{key:"Escape"});
  expect(screen.queryByRole("region",{name:"工具"})).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
