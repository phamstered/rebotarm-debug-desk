import { act, fireEvent, render, screen } from "@testing-library/react";
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
    }), JSON.stringify(store.profiles[key].positions[0]));
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
    expect(onDelete).toHaveBeenCalledWith("id-1", JSON.stringify(store.profiles[key].positions[0]));
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


it("double-clicks compact thumbnails to move without a preview pane, with contextual editing and confirmed deletion",async()=>{
  const user=userEvent.setup(),onDelete=vi.fn(),execute=vi.fn();const store=emptyPositionStore();store.profiles[key]={positions:[point('pick',[0,0,0,0,0,0])]};
  const motion={logs:[],recordLog:vi.fn(),state:{phase:'idle' as const,commandId:'',label:'',message:''},homePositions:[0,0,0,0,0,0],armed:true,busy:false,reason:'',jointRotationReason:'',jointTargetsReason:'',executeJoints:vi.fn(),executeJoint:vi.fn(),setArmed:vi.fn(),execute,cancel:vi.fn()};
  render(<MotionLayoutProvider active compact><PositionPage profileKey={key} store={store} urdfXml="" onUpdate={()=>''} onDelete={onDelete} motion={motion}/></MotionLayoutProvider>);
  await user.click(screen.getByRole('button',{name:'移动到 pick'}));expect(execute).not.toHaveBeenCalled();
  expect(screen.queryByRole('button',{name:'执行到此姿态'})).not.toBeInTheDocument();
  expect(screen.getByLabelText('点位编辑')).not.toBeVisible();
  await user.dblClick(screen.getByRole('article',{name:'pick'}));expect(execute).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('点位名称')).not.toBeInTheDocument();
  await user.dblClick(screen.getByRole('button',{name:'移动到 pick'}));expect(execute).toHaveBeenCalledExactlyOnceWith(store.profiles[key].positions[0]);
  await user.click(screen.getByRole('button',{name:'移动到 HOME'}));expect(execute).toHaveBeenCalledOnce();
  await user.dblClick(screen.getByRole('button',{name:'移动到 HOME'}));expect(execute).toHaveBeenLastCalledWith('home');
  execute.mockClear();
  screen.getByRole('button',{name:'移动到 pick'}).focus();await user.keyboard('{Enter}');expect(execute).toHaveBeenCalledOnce();
  execute.mockClear();
  screen.getByRole('button',{name:'移动到 HOME'}).focus();await user.keyboard(' ');expect(execute).toHaveBeenCalledExactlyOnceWith('home');
  await user.click(screen.getByRole('button',{name:'pick更多操作'}));await user.click(screen.getByRole('menuitem',{name:'编辑姿态'}));expect(screen.getByLabelText('点位名称')).toHaveValue('pick');expect(execute).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button',{name:'取消'}));
  await user.click(screen.getByRole('button',{name:'pick更多操作'}));await user.click(screen.getByRole('menuitem',{name:'删除姿态'}));expect(onDelete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'确认删除 pick'}));expect(onDelete).toHaveBeenCalledExactlyOnceWith('pick', JSON.stringify(store.profiles[key].positions[0]));
});


it.each([
  { name: "unarmed", patch: { armed: false } },
  { name: "busy", patch: { busy: true } },
  { name: "unready", patch: { reason: "反馈过期" } },
  { name: "gripper unavailable", patch: {}, gripperPosition: .01 },
])("blocks compact double-click motion when $name", async ({ patch, gripperPosition }) => {
  const user = userEvent.setup(), execute = vi.fn();
  const store = emptyPositionStore();
  store.profiles[key] = { positions: [{ ...point("pick", [0,0,0,0,0,0]), gripperPosition }] };
  const motion = { logs: [], recordLog: vi.fn(), state: { phase: "idle" as const, commandId: "", label: "", message: "" }, homePositions: [], armed: true, busy: false, reason: "", jointRotationReason: "", jointTargetsReason: "", executeJoints: vi.fn(), executeJoint: vi.fn(), setArmed: vi.fn(), execute, cancel: vi.fn(), ...patch };
  render(<MotionLayoutProvider active compact><PositionPage profileKey={key} store={store} urdfXml="" onUpdate={()=>''} onDelete={vi.fn()} motion={motion}/></MotionLayoutProvider>);
  expect(screen.getByRole("button", { name: "移动到 pick" })).toBeDisabled();
  await user.dblClick(screen.getByRole("button", { name: "移动到 pick" }));
  fireEvent.doubleClick(screen.getByRole("button", { name: "移动到 HOME" }));
  expect(execute).not.toHaveBeenCalled();
});

it("blocks compact thumbnail execution during editing and allows it after cancellation", async () => {
  const user = userEvent.setup(), execute = vi.fn();
  const store = emptyPositionStore();store.profiles[key] = { positions: [point("pick", [0,0,0,0,0,0])] };
  const motion = { logs: [], recordLog: vi.fn(), state: { phase: "idle" as const, commandId: "", label: "", message: "" }, homePositions: [], armed: true, busy: false, reason: "", jointRotationReason: "", jointTargetsReason: "", executeJoints: vi.fn(), executeJoint: vi.fn(), setArmed: vi.fn(), execute, cancel: vi.fn() };
  render(<MotionLayoutProvider active compact><PositionPage profileKey={key} store={store} urdfXml="" onUpdate={()=>''} onDelete={vi.fn()} motion={motion}/></MotionLayoutProvider>);
  await user.click(screen.getByRole('button',{name:'pick更多操作'}));await user.click(screen.getByRole('menuitem',{name:'编辑姿态'}));
  expect(screen.getByRole('button',{name:'移动到 pick'})).toBeDisabled();
  await user.dblClick(screen.getByRole('button',{name:'移动到 pick'}));expect(execute).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'取消'}));
  expect(screen.getByLabelText('点位编辑')).not.toBeVisible();
  await user.dblClick(screen.getByRole('button',{name:'移动到 pick'}));expect(execute).toHaveBeenCalledOnce();
});

it("keeps edit and delete baselines across external updates, retaining failed drafts", async () => {
  const user = userEvent.setup(), original = point("p", [0,0,0,0,0,0]);
  const store = emptyPositionStore(); store.profiles[key] = {positions:[original]};
  const onUpdate = vi.fn(async () => "其他窗口已修改，草稿已保留"), onDelete = vi.fn(async () => "其他窗口已修改");
  const props = {profileKey:key, store, urdfXml:"", onUpdate, onDelete};
  const view = render(<PositionPage {...props} />);
  await user.click(screen.getByRole("button", {name:"编辑"}));
  fireEvent.change(screen.getByLabelText("点位名称"), {target:{value:"本地草稿"}});
  await user.click(screen.getByRole("button", {name:"删除 p"}));
  view.rerender(<PositionPage {...props} store={{...store, profiles:{[key]:{positions:[{...original,note:"其他窗口写入"}]}}}} />);
  await user.click(screen.getByRole("button", {name:"保存点位"}));
  expect(onUpdate).toHaveBeenCalledWith("p", expect.objectContaining({name:"本地草稿"}), JSON.stringify(original));
  expect(screen.getByLabelText("点位名称")).toHaveValue("本地草稿");
  expect(screen.getByRole("alert")).toHaveTextContent("草稿已保留");
  await user.click(screen.getByRole("button", {name:"确认删除 p"}));
  expect(onDelete).toHaveBeenCalledWith("p", JSON.stringify(original));
  expect(screen.getByRole("alert")).toHaveTextContent("其他窗口已修改");
});
it("waits for save and ignores an old completion after changing profiles", async () => {
  const user = userEvent.setup(), store = emptyPositionStore();
  store.profiles[key] = {positions:[point("p", [0,0,0,0,0,0])]};
  let finish!: (error: string) => void;
  const onUpdate = vi.fn(() => new Promise<string>(resolve => {finish = resolve;}));
  const props = {profileKey:key, store, urdfXml:"", onUpdate, onDelete:vi.fn()};
  const view = render(<PositionPage {...props} />);
  await user.click(screen.getByRole("button", {name:"编辑"}));
  await user.click(screen.getByRole("button", {name:"保存点位"}));
  expect(screen.getByRole("button", {name:"保存中…"})).toBeDisabled();
  expect(screen.getByLabelText("点位名称")).toBeDisabled();
  fireEvent.submit(document.querySelector("form.position-editor")!);
  expect(onUpdate).toHaveBeenCalledOnce();
  view.rerender(<PositionPage {...props} profileKey="other" />);
  await act(async () => finish("旧错误"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("点位名称")).not.toBeInTheDocument();
});

it("restores each robot's unsaved pose draft and original conflict baseline without restoring delete confirmation", async () => {
  const user = userEvent.setup(), store = emptyPositionStore();
  const a = point("same-id", [0,0,0,0,0,0]);
  const b = {...a, name:"第二台姿态", note:"另一配置"};
  store.profiles[key] = {positions:[a]};
  store.profiles.other = {positions:[b]};
  const onUpdate = vi.fn(async () => "保存冲突，草稿已保留");
  const props = {profileKey:key,store,urdfXml:"",onUpdate,onDelete:vi.fn()};
  const view = render(<PositionPage {...props} />);
  await user.click(screen.getByRole("button",{name:"编辑"}));
  fireEvent.change(screen.getByLabelText("点位名称"),{target:{value:"第一台未保存"}});
  await user.click(screen.getByRole("button",{name:"删除 same-id"}));
  view.rerender(<PositionPage {...props} profileKey="other" />);
  expect(screen.queryByLabelText("点位名称")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"编辑"}));
  fireEvent.change(screen.getByLabelText("点位名称"),{target:{value:"第二台未保存"}});
  const updated = {...store,profiles:{...store.profiles,[key]:{positions:[{...a,note:"其他窗口修改"}]}}};
  view.rerender(<PositionPage {...props} store={updated} />);
  expect(screen.getByLabelText("点位名称")).toHaveValue("第一台未保存");
  expect(screen.queryByRole("button",{name:"确认删除 same-id"})).not.toBeInTheDocument();
  await user.click(screen.getByRole("button",{name:"保存点位"}));
  expect(onUpdate).toHaveBeenLastCalledWith(a.id,expect.objectContaining({name:"第一台未保存"}),JSON.stringify(a));
  view.rerender(<PositionPage {...props} profileKey="other" />);
  expect(screen.getByLabelText("点位名称")).toHaveValue("第二台未保存");
  await user.click(screen.getByRole("button",{name:"保存点位"}));
  expect(onUpdate).toHaveBeenLastCalledWith(b.id,expect.objectContaining({name:"第二台未保存"}),JSON.stringify(b));
});
