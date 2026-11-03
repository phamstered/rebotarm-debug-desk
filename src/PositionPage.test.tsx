import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import rebotarmUrdf from "./testFixtures/rebotarm-kinematics.urdf?raw";
import { MotionLayoutProvider } from "./MotionLayout";
import { PositionPage } from "./PositionPage";
import { emptyPositionStore, profileKeyFor } from "./positionLogic";

const key = profileKeyFor({ host: "jetson", username: "robot", sshPort: 22 });

describe("PositionPage", () => {
  it("removes creation and planner controls from the pose library", () => {
    render(<PositionPage profileKey={key} store={emptyPositionStore()} urdfXml="" onUpdate={vi.fn()} onDelete={vi.fn()} />);
    for (const name of ["保存当前姿态", "手动新增", "启动 MoveIt"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "移动到 HOME" })).toBeDisabled();
  });

  it("shows a locked HOME row and edits a typed custom point", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const store = emptyPositionStore();
    store.profiles[key] = { positions: [point("existing", [0,0,0,0,0,0])] };
    render(
      <PositionPage
        profileKey={key}
        store={store}
        urdfXml=""
        onUpdate={onUpdate}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole("article", { name: "HOME" })).toBeVisible();
    expect(screen.getByText("待同步")).toBeVisible();
    expect(screen.queryByRole("button", { name: "删除 HOME" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("点位名称"));
    await user.type(screen.getByLabelText("点位名称"), "取料位");
    const joints = screen.getAllByLabelText(/joint/);
    for (const [index, field] of joints.entries()) {
      await user.clear(field);
      await user.type(field, String(index / 10));
    }
    await user.click(screen.getByRole("button", { name: "保存点位" }));
    expect(onUpdate).toHaveBeenCalledWith("existing", expect.objectContaining({
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
        urdfXml=""
        onUpdate={vi.fn()}
        onDelete={onDelete}
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
        urdfXml={rebotarmUrdf}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const folded = screen.getByLabelText("folded 姿态");
    const bent = screen.getByLabelText("bent 姿态");
    expect(folded.querySelector('svg[data-renderer="simplified-3d"]')).toBeInTheDocument();
    expect(bent.querySelector("svg")?.outerHTML).not.toBe(folded.querySelector("svg")?.outerHTML);
    expect(folded.getAttribute("data-tip")).not.toBe(bent.getAttribute("data-tip"));
    expect(screen.getByLabelText("HOME 姿态未同步")).toBeVisible();
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
  render(<PositionPage profileKey={key} store={store} urdfXml="" onUpdate={vi.fn()} onDelete={vi.fn()}
    motion={{ logs: [], recordLog: vi.fn(), state: { phase: "idle", commandId: "", label: "", message: "" }, homePositions: [0, -.01, -.01, 0, 0, 0], armed: true, busy: false, reason: "", jointRotationReason: "", jointTargetsReason: "", executeJoints: vi.fn(), executeJoint: vi.fn(), setArmed: vi.fn(), execute, cancel: vi.fn() }} />);
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


it("selects a compact pose without moving and exposes contextual editing and confirmed deletion",async()=>{
  const user=userEvent.setup(),onDelete=vi.fn(),execute=vi.fn();const store=emptyPositionStore();store.profiles[key]={positions:[point('pick',[0,0,0,0,0,0])]};
  const motion={logs:[],recordLog:vi.fn(),state:{phase:'idle' as const,commandId:'',label:'',message:''},homePositions:[],armed:true,busy:false,reason:'',jointRotationReason:'',jointTargetsReason:'',executeJoints:vi.fn(),executeJoint:vi.fn(),setArmed:vi.fn(),execute,cancel:vi.fn()};
  render(<MotionLayoutProvider active compact><PositionPage profileKey={key} store={store} urdfXml="" onUpdate={()=>''} onDelete={onDelete} motion={motion}/></MotionLayoutProvider>);
  await user.click(screen.getByRole('button',{name:'预览 pick'}));expect(execute).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'执行到此姿态'}));expect(execute).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button',{name:'pick更多操作'}));await user.click(screen.getByRole('menuitem',{name:'编辑姿态'}));expect(screen.getByLabelText('点位名称')).toHaveValue('pick');expect(execute).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button',{name:'取消'}));
  await user.click(screen.getByRole('button',{name:'pick更多操作'}));await user.click(screen.getByRole('menuitem',{name:'删除姿态'}));expect(onDelete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'确认删除 pick'}));expect(onDelete).toHaveBeenCalledExactlyOnceWith('pick');
});
