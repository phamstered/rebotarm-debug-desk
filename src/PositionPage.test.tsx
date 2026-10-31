import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import rebotarmUrdf from "./testFixtures/rebotarm-kinematics.urdf?raw";
import { PositionPage } from "./PositionPage";
import { emptyPositionStore, profileKeyFor } from "./positionLogic";

const key = profileKeyFor({ host: "jetson", username: "robot", sshPort: 22 });

describe("PositionPage", () => {
  it("starts the planner explicitly without arming or moving a saved position", async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    const view = render(<PositionPage profileKey={key} store={emptyPositionStore()} captureError="" urdfXml=""
      onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onCapture={vi.fn()}
      planner={{start, busy: false, disabledReason: "请先启动 Trajectory", notice: "", workflow: null}} />);
    expect(screen.getByRole("button", {name: "启动 MoveIt"})).toBeDisabled();
    view.rerender(<PositionPage profileKey={key} store={emptyPositionStore()} captureError="" urdfXml=""
      onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onCapture={vi.fn()}
      planner={{start, busy: false, disabledReason: "", notice: "", workflow: null}} />);
    await user.click(screen.getByRole("button", {name: "启动 MoveIt"}));
    expect(start).toHaveBeenCalledOnce();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", {name: "移动到 HOME"})).toBeDisabled();
  });

  it("shows planner startup failure at the actual stage and blocks duplicate starts", () => {
    render(<PositionPage profileKey={key} store={emptyPositionStore()} captureError="" urdfXml=""
      onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onCapture={vi.fn()}
      planner={{start: vi.fn(), busy: true, disabledReason: "", notice: "",
        workflow: {mode: "moveit", stage: "planner", message: "Planning Scene 超时", failed: true, running: false}}} />);
    expect(screen.getByRole("button", {name: "MoveIt 启动中…"})).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Planning Scene 超时");
  });
  it("shows a locked HOME row and saves a typed custom point", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <PositionPage
        profileKey={key}
        store={emptyPositionStore()}
        captureError="没有新鲜的关节反馈"
        urdfXml=""
        onCreate={onCreate}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onCapture={vi.fn()}
      />,
    );

    expect(screen.getByRole("article", { name: "HOME" })).toBeVisible();
    expect(screen.getByText("待同步")).toBeVisible();
    expect(screen.queryByRole("button", { name: "删除 HOME" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存当前姿态" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "手动新增" }));
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
        urdfXml=""
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

  it("shows a different URDF pose thumbnail for each saved position", () => {
    const store = emptyPositionStore();
    store.profiles[key] = {
      positions: [
        point("folded", [0, 0, 0, 0, 0, 0]),
        point("bent", [0.4, -1.2, -0.8, 0.3, 0.2, 0]),
      ],
    };
    render(
      <PositionPage
        profileKey={key}
        store={store}
        captureError=""
        urdfXml={rebotarmUrdf}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onCapture={vi.fn()}
      />,
    );
    const folded = screen.getByLabelText("folded 姿态");
    const bent = screen.getByLabelText("bent 姿态");
    expect(folded.getAttribute("data-tip")).not.toBe(bent.getAttribute("data-tip"));
    expect(screen.getByLabelText("HOME 姿态未同步")).toBeVisible();
  });

  it("fills a new point from the current arm pose", async () => {
    const user = userEvent.setup();
    const onCapture = vi.fn(() => ({ positions: [0.1, -0.2, -0.3, 0.4, 0.5, 0.6] }));
    render(
      <PositionPage
        profileKey={key}
        store={emptyPositionStore()}
        captureError=""
        urdfXml={rebotarmUrdf}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onCapture={onCapture}
      />,
    );
    await user.click(screen.getByRole("button", { name: "保存当前姿态" }));
    expect(onCapture).toHaveBeenCalled();
    expect(screen.getByLabelText("点位名称")).toHaveValue("姿态 1");
    expect(screen.getByLabelText("joint2")).toHaveValue("-0.2");
    expect(screen.getByLabelText("正在保存 姿态")).toBeVisible();
  });
});

function point(id: string, positions: number[]) {
  return {
    id,
    name: id,
    group: "arm" as const,
    jointNames: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
    positions,
    source: "manual" as const,
    note: "",
    capturedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

it("clicks a position to move while edit and delete remain separate", async () => {
  const user = userEvent.setup();
  const execute = vi.fn();
  const store = emptyPositionStore(); store.profiles[key] = { positions: [point("pick", [0, -.2, -.2, 0, 0, 0])] };
  render(<PositionPage profileKey={key} store={store} captureError="" urdfXml="" onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={vi.fn()} onCapture={vi.fn()}
    motion={{ state: { phase: "idle", commandId: "", label: "", message: "" }, homePositions: [0, -.01, -.01, 0, 0, 0], armed: true, busy: false, reason: "", setArmed: vi.fn(), execute, cancel: vi.fn() }} />);
  await user.click(screen.getByRole("button", { name: "编辑" }));
  await user.click(screen.getByRole("button", { name: "删除 pick" }));
  expect(execute).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "移动到 pick" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "移动到 pick" }));
  expect(execute).toHaveBeenCalledWith(store.profiles[key].positions[0]);
  await user.click(screen.getByRole("button", { name: "移动到 HOME" }));
  expect(execute).toHaveBeenCalledWith("home");
});
