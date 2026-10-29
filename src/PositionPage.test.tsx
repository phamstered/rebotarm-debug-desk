import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PositionPage } from "./PositionPage";
import { emptyPositionStore, profileKeyFor } from "./positionLogic";

const key = profileKeyFor({ host: "jetson", username: "robot", sshPort: 22 });

describe("PositionPage", () => {
  it("shows a locked HOME row and saves a typed custom point", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <PositionPage
        profileKey={key}
        store={emptyPositionStore()}
        captureError="没有新鲜的关节反馈"
        onCreate={onCreate}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onCapture={vi.fn()}
      />,
    );

    expect(screen.getByRole("article", { name: "HOME" })).toBeVisible();
    expect(screen.getByText("待同步")).toBeVisible();
    expect(screen.queryByRole("button", { name: "删除 HOME" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "读取当前位置" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "新增" }));
    await user.type(screen.getByLabelText("点位名称"), "取料位");
    const joints = screen.getAllByLabelText(/joint/);
    for (const [index, field] of joints.entries()) {
      await user.clear(field);
      await user.type(field, String(index / 10));
    }
    await user.click(screen.getByRole("button", { name: "保存点位" }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: "取料位",
      positions: [0, 0.1, 0.2, 0.3, 0.4, 0.5],
    }));
  });

  it("asks before deleting a custom point", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const store = emptyPositionStore();
    store.profiles[key] = {
      positions: [{
        id: "id-1",
        name: "取料位",
        group: "arm",
        jointNames: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
        positions: [0, 0, 0, 0, 0, 0],
        source: "manual",
        note: "",
        capturedAt: null,
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    render(
      <PositionPage
        profileKey={key}
        store={store}
        captureError=""
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={onDelete}
        onCapture={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "删除 取料位" }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认删除 取料位" }));
    expect(onDelete).toHaveBeenCalledWith("id-1");
  });
});
