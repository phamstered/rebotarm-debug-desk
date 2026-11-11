import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SavePoseDialog } from "./SavePoseDialog";
import type { PositionDraft } from "./positionLogic";

const initial: PositionDraft = { name: "姿态 1", positions: [0.1,-0.2,-0.3,0.4,0.5,0.6], source: "feedback", note: "", gripperPosition: .025 };
it("saves the captured arm and optional calibrated gripper without a motion operation", async () => {
  const user = userEvent.setup(), onSave = vi.fn(() => ""), onClose = vi.fn();
  render(<SavePoseDialog initial={initial} urdfXml="" onSave={onSave} onClose={onClose} />);
  expect(screen.getByLabelText("点位名称")).toHaveValue("姿态 1");
  expect(screen.getByLabelText("保存夹爪目标")).toBeChecked();
  expect(screen.getByLabelText("夹爪行程 mm")).toHaveValue("25");
  await user.type(screen.getByLabelText("姿态备注"), "取料");
  await user.click(screen.getByRole("button", {name:"保存点位"}));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({...initial,note:"取料"});
  expect(onClose).toHaveBeenCalledOnce();
});
it("keeps the dialog and draft on validation failure, then permits saving without a gripper", async () => {
  const user = userEvent.setup(), onSave = vi.fn(() => "名称重复"), onClose = vi.fn();
  render(<SavePoseDialog initial={initial} urdfXml="" onSave={onSave} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText("夹爪行程 mm"), {target:{value:"NaN"}});
  await user.click(screen.getByRole("button", {name:"保存点位"}));
  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效的夹爪行程");
  expect(onSave).not.toHaveBeenCalled();
  await user.click(screen.getByLabelText("保存夹爪目标"));
  await user.click(screen.getByRole("button", {name:"保存点位"}));
  expect(screen.getByRole("alert")).toHaveTextContent("名称重复");
  expect(onSave).toHaveBeenCalledWith({...initial,gripperPosition:undefined});
  expect(onClose).not.toHaveBeenCalled();
});
it("explains unavailable gripper feedback and cancels without writing", async () => {
  const user = userEvent.setup(), onSave = vi.fn(), onClose = vi.fn();
  render(<SavePoseDialog initial={{...initial,gripperPosition:undefined}} urdfXml="" onSave={onSave} onClose={onClose} />);
  expect(screen.getByText(/夹爪反馈不可用/)).toBeVisible();
  expect(screen.getByLabelText("保存夹爪目标")).not.toBeChecked();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
});

it("waits for durable save, blocks repeated submission and retains the draft on disk failure", async () => {
  let finish!: (failure: string) => void;
  const user = userEvent.setup(), onClose = vi.fn(), onSave = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  render(<SavePoseDialog initial={initial} urdfXml="" onSave={onSave} onClose={onClose} />);
  await user.type(screen.getByLabelText("姿态备注"), "保留草稿");
  await user.click(screen.getByRole("button", {name:"保存点位"}));
  expect(screen.getByRole("button", {name:"保存中…"})).toBeDisabled();
  expect(screen.getByLabelText("点位名称")).toBeDisabled();
  await user.keyboard("{Escape}");
  fireEvent.submit(document.getElementById("save-current-pose")!);
  expect(onClose).not.toHaveBeenCalled(); expect(onSave).toHaveBeenCalledOnce();
  await act(async () => finish("磁盘已满"));
  expect(screen.getByRole("alert")).toHaveTextContent("磁盘已满");
  expect(screen.getByLabelText("姿态备注")).toHaveValue("保留草稿");
  expect(screen.getByRole("button", {name:"保存点位"})).toBeEnabled(); expect(onClose).not.toHaveBeenCalled();
});
