import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  MotionGroupsPage,
  type MotionGroupsPageProps,
} from "./MotionGroupsPage";
import { MotionLayoutProvider } from "./MotionLayout";
import type { CustomPosition } from "./positionLogic";
import type { MotionGroup } from "./motionGroupsLogic";
import type { PositionMotionControls } from "./positionMotionLogic";
const position: CustomPosition = {
  id: "p",
  name: "A",
  group: "arm",
  jointNames: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
  positions: [0, 0, 0, 0, 0, 0],
  source: "manual",
  note: "",
  capturedAt: null,
  createdAt: 1,
  updatedAt: 1,
};
const group: MotionGroup = {
  id: "g",
  name: "取放",
  note: "",
  preparationDuration: 5,
  createdAt: 1,
  updatedAt: 1,
  steps: [
    {
      id: "a",
      positionId: "p",
      positionName: "A",
      positionUpdatedAt: 1,
      positions: [0, 0, 0, 0, 0, 0],
      duration: 0,
      hold: 1,
    },
    {
      id: "b",
      positionId: "q",
      positionName: "B",
      positionUpdatedAt: 1,
      positions: [1, 1, 1, 1, 1, 1],
      duration: 4,
      hold: 2,
    },
  ],
};
const other: MotionGroup = { ...group, id: "h", name: "另一组" };
function props(
  overrides: Partial<MotionGroupsPageProps> = {},
): MotionGroupsPageProps {
  const motion: PositionMotionControls = {
    logs: [],
    recordLog: vi.fn(),
    state: { commandId: "", label: "", phase: "idle", message: "" },
    homePositions: [],
    reason: "",
    busy: false,
    armed: true,
    setArmed: vi.fn(),
    execute: vi.fn(),
    jointRotationReason: "",
    executeJoint: vi.fn(),
    jointTargetsReason: "",
    executeJoints: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
    groupReason: "",
    executeGroup: vi.fn().mockResolvedValue(undefined),
    pauseGroup: vi.fn().mockResolvedValue(undefined),
    resumeGroup: vi.fn().mockResolvedValue(undefined),
  };
  return {
    profileKey: "jetson",
    groups: [group, other],
    positions: [position],
    ready: true,
    saving: false,
    error: "",
    urdfXml: "",
    onSave: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    motion,
    ...overrides,
  };
}
describe("MotionGroupsPage", () => {
  it("offers adjustable panels, precise timing and a local-only preview", async () => {
    const value = props(),
      user = userEvent.setup();
    render(
      <MotionLayoutProvider active>
        <MotionGroupsPage {...value} />
      </MotionLayoutProvider>,
    );
    expect(screen.getAllByRole("separator")).toHaveLength(4);
    expect(screen.getByLabelText("运动时长 (s)")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "关键帧 2 B" }));
    expect(screen.getByLabelText("运动时长 (s)")).toHaveValue(4);
    fireEvent.change(screen.getByRole("slider", { name: "预览播放头" }), {
      target: { value: "3" },
    });
    expect(value.motion.executeGroup).not.toHaveBeenCalled();
    expect(screen.getByText("本地预览 · 3 s")).toBeVisible();
    fireEvent.keyDown(screen.getByRole("button", { name: "关键帧 2 B" }), {
      key: "ArrowRight",
    });
    expect(screen.getByLabelText("运动时长 (s)")).toHaveValue(4.1);
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByLabelText("运动时长 (s)")).toHaveValue(4);
    await user.click(screen.getByRole("button", { name: "重做" }));
    expect(screen.getByLabelText("运动时长 (s)")).toHaveValue(4.1);
  });
  it("retains immutable snapshots until an explicit source refresh", async () => {
    const value = props({
        positions: [
          { ...position, positions: [2, 2, 2, 2, 2, 2], updatedAt: 2 },
        ],
      }),
      user = userEvent.setup();
    render(<MotionGroupsPage {...value} />);
    expect(screen.getByText(/来源已更新/)).toBeVisible();
    expect(
      screen.getByText("关节快照：0.000, 0.000, 0.000, 0.000, 0.000, 0.000"),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "刷新来源快照" }));
    expect(
      screen.getByText("关节快照：2.000, 2.000, 2.000, 2.000, 2.000, 2.000"),
    ).toBeVisible();
    expect(group.steps[0].positions).toEqual([0, 0, 0, 0, 0, 0]);
    await user.click(screen.getByRole("button", { name: "关键帧 2 B" }));
    expect(screen.getByText(/来源已删除/)).toBeVisible();
    expect(screen.getByRole("button", { name: "刷新来源快照" })).toBeDisabled();
  });
  it("waits for successful save before switching, retains dirty state after failure", async () => {
    let resolve!: () => void;
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("磁盘已满"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
    const value = props({ onSave }),
      user = userEvent.setup();
    render(<MotionGroupsPage {...value} />);
    fireEvent.change(screen.getByLabelText("动作组名称"), {
      target: { value: "编辑中" },
    });
    await user.click(screen.getByRole("button", { name: "另一组 · 2 帧" }));
    await user.click(screen.getByRole("button", { name: "保存并切换" }));
    expect(screen.getByRole("alert")).toHaveTextContent("磁盘已满");
    expect(screen.getByLabelText("动作组名称")).toHaveValue("编辑中");
    await user.click(screen.getByRole("button", { name: "保存并切换" }));
    expect(screen.getByLabelText("动作组名称")).toHaveValue("编辑中");
    await act(async () => resolve());
    expect(screen.getByLabelText("动作组名称")).toHaveValue("另一组");
  });
  it("creates a valid first snapshot, supports reorder and blocks invalid durations", async () => {
    const value = props({ groups: [] }),
      user = userEvent.setup();
    render(<MotionGroupsPage {...value} />);
    await user.click(screen.getByRole("button", { name: "新建动作组" }));
    expect(screen.getByRole("button", { name: "保存动作组" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "添加 A" }));
    await user.click(screen.getByRole("button", { name: "添加 A" }));
    expect(screen.getByLabelText("运动时长 (s)")).toHaveValue(5);
    fireEvent.change(screen.getByLabelText("运动时长 (s)"), {
      target: { value: "" },
    });
    expect(
      screen.getByRole("button", { name: "执行当前未保存快照" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存动作组" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    await user.click(screen.getByRole("button", { name: "上移关键帧 2" }));
    expect(screen.getByLabelText("运动时长 (s)")).toHaveValue(0);
    await user.click(screen.getByRole("button", { name: "保存动作组" }));
    expect(value.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({ duration: 0 }),
          expect.objectContaining({ duration: 5 }),
        ],
      }),
    );
  });
  it("requires explicit capability and safety arming", async () => {
    const value = props(),
      user = userEvent.setup();
    value.motion.armed = false;
    const view = render(<MotionGroupsPage {...value} />);
    expect(screen.getByRole("button", { name: "执行动作组" })).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /已确认工作区安全/ }),
    );
    expect(value.motion.setArmed).toHaveBeenCalledWith(true);
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{ ...value.motion, armed: true, executeGroup: undefined }}
      />,
    );
    expect(screen.getByRole("button", { name: "执行动作组" })).toBeDisabled();
    expect(screen.getByText("当前连接不支持动作组执行")).toBeVisible();
  });
  it("executes a fixed copy and keeps editing other groups independent", async () => {
    const value = props(),
      user = userEvent.setup();
    render(<MotionGroupsPage {...value} />);
    await user.click(screen.getByRole("button", { name: "执行动作组" }));
    await waitFor(() =>
      expect(value.motion.executeGroup).toHaveBeenCalledOnce(),
    );
    const copy = vi.mocked(value.motion.executeGroup!).mock.calls[0][0];
    await user.click(screen.getByRole("button", { name: "另一组 · 2 帧" }));
    fireEvent.change(screen.getByLabelText("停留时长 (s)"), {
      target: { value: "9" },
    });
    expect(copy.steps[0].hold).toBe(1);
    expect(copy).not.toBe(group);
    expect(copy.steps[0].positions).not.toBe(group.steps[0].positions);
  });
  it("distinguishes a pause reservation from paused, and always offers stop", async () => {
    const value = props(),
      user = userEvent.setup();
    value.motion = {
      ...value.motion,
      busy: true,
      state: {
        commandId: "run",
        label: "取放",
        phase: "executing",
        message: "已预约暂停",
        group: { id: "g", index: 0, count: 2, phase: "moving", elapsed: 12 },
      },
    };
    const view = render(<MotionGroupsPage {...value} />);
    await user.click(screen.getByRole("button", { name: "预约段间暂停" }));
    expect(value.motion.pauseGroup).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "恢复执行" })).toBeDisabled();
    expect(screen.queryByText(/· 已暂停/)).not.toBeInTheDocument();
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{
          ...value.motion,
          armed: false,
          state: { ...value.motion.state, phase: "paused" },
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "恢复执行" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "停止动作组" }));
    expect(value.motion.cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("slider", { name: "预览播放头" })).toHaveValue("0");
  });
  it("isolates profile drafts and ignores a previous profile's late save result", async () => {
    let resolve!: () => void;
    const value = props({
        onSave: vi.fn(
          () =>
            new Promise<void>((done) => {
              resolve = done;
            }),
        ),
      }),
      user = userEvent.setup();
    const view = render(<MotionGroupsPage {...value} />);
    fireEvent.change(screen.getByLabelText("动作组名称"), {
      target: { value: "jetson未保存" },
    });
    await user.click(screen.getByRole("button", { name: "保存动作组" }));
    view.rerender(
      <MotionGroupsPage {...value} profileKey="simulator" groups={[other]} />,
    );
    expect(screen.getByLabelText("动作组名称")).toHaveValue("另一组");
    await act(async () => resolve());
    expect(screen.getByLabelText("动作组名称")).toHaveValue("另一组");
    view.rerender(<MotionGroupsPage {...value} />);
    expect(screen.getByLabelText("动作组名称")).toHaveValue("jetson未保存");
    expect(screen.getByText("有未保存修改")).toBeVisible();
  });
  it("blocks writes on storage errors and awaits confirmed deletion", async () => {
    const value = props({ error: "文件损坏" }),
      user = userEvent.setup();
    const view = render(<MotionGroupsPage {...value} />);
    expect(screen.getByRole("button", { name: "新建动作组" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除动作组" })).toBeDisabled();
    let resolve!: () => void;
    view.rerender(
      <MotionGroupsPage
        {...value}
        error=""
        onDelete={vi.fn(
          () =>
            new Promise<void>((done) => {
              resolve = done;
            }),
        )}
      />,
    );
    await user.click(screen.getByRole("button", { name: "删除动作组" }));
    await user.click(screen.getByRole("button", { name: "确认删除动作组" }));
    expect(screen.getByLabelText("动作组名称")).toHaveValue("取放");
    await act(async () => resolve());
    expect(screen.queryByLabelText("动作组名称")).not.toBeInTheDocument();
  });
  it("does not expose controls for a completed owned group while another session is busy", () => {
    const value = props();
    value.motion = {
      ...value.motion,
      busy: true,
      state: {
        commandId: "old",
        label: "completed",
        phase: "succeeded",
        message: "完成",
        group: { id: "g", index: 1, count: 2, phase: "holding", elapsed: 20 },
      },
    };
    render(<MotionGroupsPage {...value} />);
    expect(
      screen.queryByRole("button", { name: "停止动作组" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "预约段间暂停" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "恢复执行" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行动作组" })).toBeDisabled();
  });
  it("returns directly when clean and requires successful save or discard before leaving a dirty editor", async () => {
    let resolve!: () => void;
    const onBack = vi.fn();
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("只读目录"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
    const value = props({ onBack, onSave }),
      user = userEvent.setup();
    render(<MotionGroupsPage {...value} />);
    await user.click(screen.getByRole("button", { name: "返回连接" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    onBack.mockClear();
    fireEvent.change(screen.getByLabelText("动作组名称"), {
      target: { value: "离线编辑" },
    });
    await user.click(screen.getByRole("button", { name: "返回连接" }));
    expect(screen.getByRole("dialog", { name: "未保存修改" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByLabelText("动作组名称")).toHaveValue("离线编辑");
    await user.click(screen.getByRole("button", { name: "返回连接" }));
    await user.click(screen.getByRole("button", { name: "保存并切换" }));
    expect(screen.getByRole("alert")).toHaveTextContent("只读目录");
    expect(onBack).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "保存并切换" }));
    expect(onBack).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("动作组名称")).toHaveValue("离线编辑");
    onBack.mockClear();
    fireEvent.change(screen.getByLabelText("动作组名称"), {
      target: { value: "放弃这个草稿" },
    });
    await user.click(screen.getByRole("button", { name: "返回连接" }));
    await user.click(screen.getByRole("button", { name: "放弃并切换" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("动作组名称")).toHaveValue("取放");
    expect(screen.getByText("已保存")).toBeVisible();
  });
  it("keeps the owned failed result visible while editing another group, without exposing controls for external busy", async () => {
    const value = props(),
      user = userEvent.setup();
    value.motion = {
      ...value.motion,
      busy: true,
      state: {
        commandId: "failed-home",
        label: "取放",
        phase: "failed",
        message: "Action 异常中止",
        group: {
          id: "g",
          index: 0,
          count: 2,
          phase: "preparing",
          elapsed: 5,
          stepLabel: "HOME",
        },
        positionErrorCheckEnforced: false,
      },
    };
    render(<MotionGroupsPage {...value} />);
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("第 1/2 帧 · HOME · 首帧准备");
    expect(screen.getByText(/后续关键帧未执行/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "另一组 · 2 帧" }));
    expect(screen.getByLabelText("动作组名称")).toHaveValue("另一组");
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("最近执行的「取放」动作组");
    expect(
      screen.queryByRole("button", { name: "停止动作组" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "预约段间暂停" }),
    ).not.toBeInTheDocument();
  });
  it("binds a result to the fixed execution snapshot and keeps it after a subsequent non-group task", async () => {
    const value = props(),
      user = userEvent.setup();
    const view = render(<MotionGroupsPage {...value} />);
    await user.click(screen.getByRole("button", { name: "执行动作组" }));
    const state = {
      commandId: "fixed-run",
      label: "取放",
      phase: "executing" as const,
      message: "运动中",
      group: {
        id: "g",
        index: 0,
        count: 2,
        phase: "preparing" as const,
        elapsed: 1,
      },
    };
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{ ...value.motion, busy: true, state }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "最近动作组执行结果" }),
      ).toHaveTextContent("第 1/2 帧 · A · 首帧准备"),
    );
    await user.click(screen.getByRole("button", { name: "另一组 · 2 帧" }));
    fireEvent.change(screen.getByLabelText("动作组名称"), {
      target: { value: "正在编辑的新组名" },
    });
    const success = {
      ...state,
      phase: "succeeded" as const,
      message: "Action 成功且已停稳",
      positionErrorCheckEnforced: false,
    };
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{ ...value.motion, busy: false, state: success }}
      />,
    );
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("最近执行的「取放」动作组");
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("执行成功");
    expect(screen.getByLabelText("动作组名称")).toHaveValue("正在编辑的新组名");
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{
          ...value.motion,
          busy: true,
          state: {
            commandId: "single-joint",
            label: "joint4",
            phase: "executing",
            message: "单关节运动",
          },
        }}
      />,
    );
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("执行成功");
    expect(
      screen.queryByRole("button", { name: "停止动作组" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{
          ...value.motion,
          state: { commandId: "", label: "", phase: "idle", message: "" },
        }}
      />,
    );
    expect(
      screen.queryByRole("status", { name: "最近动作组执行结果" }),
    ).not.toBeInTheDocument();
  });
  it("retains canceled and rejected results with frame metadata while remaining retryable", () => {
    const value = props();
    const state = {
      commandId: "cancelled",
      label: "取放",
      phase: "canceled" as const,
      message: "用户取消",
      group: {
        id: "g",
        index: 1,
        count: 2,
        phase: "moving" as const,
        elapsed: 4,
        stepLabel: "B",
      },
    };
    const view = render(
      <MotionGroupsPage {...value} motion={{ ...value.motion, state }} />,
    );
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("已取消");
    expect(screen.getByRole("button", { name: "执行动作组" })).toBeEnabled();
    view.rerender(
      <MotionGroupsPage
        {...value}
        motion={{
          ...value.motion,
          state: {
            ...state,
            commandId: "rejected",
            phase: "failed",
            message: "Controller 未激活，拒绝启动",
            group: {
              ...state.group,
              index: 0,
              phase: "preparing",
              stepLabel: "HOME",
            },
          },
        }}
      />,
    );
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("Controller 未激活，拒绝启动");
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("第 1/2 帧 · HOME");
    expect(
      screen.queryByRole("button", { name: "停止动作组" }),
    ).not.toBeInTheDocument();
  });
  it("shows the result beside execution controls and scrolls to diagnostics only on an explicit request", async () => {
    const scroll = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scroll,
    });
    try {
      const value = props(),
        user = userEvent.setup();
      const state = {
        commandId: "result",
        label: "取放",
        phase: "failed" as const,
        message: "Action 失败",
        group: {
          id: "g",
          index: 0,
          count: 2,
          phase: "preparing" as const,
          elapsed: 2,
          stepLabel: "HOME",
        },
      };
      const view = render(
        <MotionGroupsPage {...value} motion={{ ...value.motion, state }} />,
      );
      expect(scroll).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "查看详细结果" }).closest("footer"),
      ).toHaveTextContent("最近执行的「取放」动作组 · 执行失败");
      view.rerender(
        <MotionGroupsPage
          {...value}
          motion={{
            ...value.motion,
            state: { ...state, message: "Action 失败，机器人已停稳" },
          }}
        />,
      );
      expect(scroll).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "查看详细结果" }));
      expect(scroll).toHaveBeenCalledExactlyOnceWith({
        block: "start",
        behavior: "smooth",
      });
    } finally {
      if (descriptor)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          descriptor,
        );
      else
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });
});
