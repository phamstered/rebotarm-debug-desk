import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ModalShell } from "./ModalShell";

it("traps keyboard and programmatic focus, closes with Escape, and restores the opener", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>打开</button><button>外部</button>{open && <ModalShell title="控制器确认" onClose={() => setOpen(false)} actions={<><button autoFocus onClick={() => setOpen(false)}>取消</button><button>确认</button></>}>确认现场允许切换。</ModalShell>}</>;
  }
  render(<Example />);
  const opener = screen.getByRole("button", { name: "打开" });
  await user.click(opener);
  expect(screen.getByRole("dialog", { name: "控制器确认" })).toBeVisible();
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  screen.getByRole("button", { name: "确认" }).focus();
  await user.tab();
  expect(screen.getByRole("button", { name: "关闭控制器确认" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "确认" })).toHaveFocus();
  screen.getByRole("button", { name: "外部" }).focus();
  expect(screen.getByRole("button", { name: "关闭控制器确认" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
