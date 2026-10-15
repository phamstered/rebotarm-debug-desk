import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MonitorPage } from "./MonitorPage";
import {
  addMonitorDashboard,
  createDefaultMonitorWorkspace,
  createEmptyDashboard,
  updateDashboardLayout,
} from "./monitorLogic";

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    jointStateTopic: "/stm32/joint_states",
    liveUpdates: true,
    bagStatus: null as null,
    bagBusy: false,
    bagNotice: "",
    onSelectDashboard: () => undefined,
    onAddDashboard: () => undefined,
    onRenameDashboard: () => undefined,
    onDeleteDashboard: () => undefined,
    onLayoutChange: () => undefined,
    onRemovePanel: () => undefined,
    onUpdatePanelChart: () => undefined,
    onClearPanels: () => undefined,
    onResetLayout: () => undefined,
    onApplyWorkspace: () => undefined,
    onToggleLiveUpdates: () => undefined,
    onSetLayoutLocked: () => undefined,
    onSetCompactType: () => undefined,
    onRefreshBagStatus: () => undefined,
    onStartBagPlay: () => undefined,
    onStopBagPlay: () => undefined,
    ...overrides,
  };
}

describe("MonitorPage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders default torque dashboard panels and supports create/rename/delete", async () => {
    const user = userEvent.setup();
    let workspace = createDefaultMonitorWorkspace("/stm32/joint_states");
    const onSelectDashboard = vi.fn((id: string) => {
      workspace = { ...workspace, selectedDashboardId: id };
    });
    const onAddDashboard = vi.fn((dashboard) => {
      workspace = addMonitorDashboard(workspace, dashboard);
    });
    const onRenameDashboard = vi.fn();
    const onDeleteDashboard = vi.fn();
    const { rerender } = render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          onSelectDashboard,
          onAddDashboard,
          onRenameDashboard,
          onDeleteDashboard,
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Monitor" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Motor Torque/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("effort[0] 曲线")).toBeVisible();
    expect(screen.getByLabelText("effort[6] 曲线")).toBeVisible();
    expect(screen.getByText(/7 个 Panel · 窗口/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "新建空仪表盘" }));
    expect(onAddDashboard).toHaveBeenCalled();
    workspace = addMonitorDashboard(workspace, createEmptyDashboard("Custom"));
    rerender(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          onSelectDashboard,
          onAddDashboard,
          onRenameDashboard,
          onDeleteDashboard,
        })}
      />,
    );
    const name = screen.getByLabelText("仪表盘名称");
    await user.clear(name);
    await user.type(name, "My Panel");
    await user.tab();
    expect(onRenameDashboard).toHaveBeenCalledWith(workspace.selectedDashboardId, "My Panel");

    await user.click(screen.getByRole("button", { name: /删除仪表盘/ }));
    expect(onDeleteDashboard).toHaveBeenCalledWith(workspace.selectedDashboardId);
  });

  it("validates bag path before starting playback", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          jointStateTopic: "/js",
          onStartBagPlay: onStart,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Bag 回放" }));
    const path = screen.getByLabelText("Jetson bag 路径");
    await user.clear(path);
    await user.type(path, "bad;rm");
    await user.click(screen.getByRole("button", { name: "开始回放" }));
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText(/路径仅允许/)).toBeVisible();

    await user.clear(path);
    await user.type(path, "robot-console-bags/demo");
    await user.click(screen.getByRole("button", { name: "开始回放" }));
    expect(onStart).toHaveBeenCalledWith("robot-console-bags/demo");
  });

  it("adds a torque template dashboard and switches tabs", async () => {
    const user = userEvent.setup();
    let workspace = createDefaultMonitorWorkspace("/stm32/joint_states");
    const torqueId = workspace.selectedDashboardId;
    const onSelectDashboard = vi.fn();
    const onAddDashboard = vi.fn();
    const props = baseProps({ onSelectDashboard, onAddDashboard });
    const { rerender } = render(<MonitorPage workspace={workspace} {...props} />);

    await user.click(screen.getByRole("button", { name: "添加力矩模板仪表盘" }));
    expect(onAddDashboard).toHaveBeenCalledWith(expect.objectContaining({
      name: "Motor Torque",
      panels: expect.arrayContaining([
        expect.objectContaining({
          series: expect.objectContaining({ fieldPath: "effort[0]", topic: "/stm32/joint_states" }),
        }),
        expect.objectContaining({
          series: expect.objectContaining({ fieldPath: "effort[6]" }),
        }),
      ]),
    }));
    expect(onAddDashboard.mock.calls[0]![0].panels).toHaveLength(7);

    workspace = addMonitorDashboard(workspace, createEmptyDashboard("Second", "dashboard-second"));
    rerender(<MonitorPage workspace={workspace} {...props} />);
    expect(screen.getByRole("tab", { name: /Second/ })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: /Motor Torque/ }));
    expect(onSelectDashboard).toHaveBeenCalledWith(torqueId);
  });

  it("removes panels from their header and stops bag playback", async () => {
    const user = userEvent.setup();
    const onRemovePanel = vi.fn();
    const onClearPanels = vi.fn();
    const onStop = vi.fn();
    const onRefresh = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          jointStateTopic: "/js",
          liveUpdates: false,
          bagStatus: { playing: true, pid: 123, bagPath: "robot-console-bags/demo", message: "playing" },
          bagNotice: "note",
          onRemovePanel,
          onClearPanels,
          onRefreshBagStatus: onRefresh,
          onStopBagPlay: onStop,
        })}
      />,
    );

    expect(screen.getAllByText(/已暂停/).length).toBeGreaterThan(0);
    const firstPanel = document.querySelector<HTMLElement>(`[data-panel-id="${workspace.dashboards[0]!.panels[0]!.id}"]`)!;
    expect(within(firstPanel).getAllByText("effort[0]")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "移除 effort[0]" }));
    expect(onRemovePanel).toHaveBeenCalledWith(
      workspace.selectedDashboardId,
      workspace.dashboards[0]!.panels[0]!.id,
    );

    await user.click(screen.getByRole("button", { name: "清空面板" }));
    expect(onClearPanels).toHaveBeenCalledWith(workspace.selectedDashboardId);

    await user.click(screen.getByRole("button", { name: "Bag 回放" }));
    expect(screen.getByText("note")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "刷新状态" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "停止回放" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("exposes follow / lock / compact / reset layout controls", async () => {
    const user = userEvent.setup();
    const onToggleLiveUpdates = vi.fn();
    const onSetLayoutLocked = vi.fn();
    const onSetCompactType = vi.fn();
    const onResetLayout = vi.fn();
    let workspace = createDefaultMonitorWorkspace("/js");
    const { rerender } = render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          jointStateTopic: "/js",
          onToggleLiveUpdates,
          onSetLayoutLocked,
          onSetCompactType,
          onResetLayout,
        })}
      />,
    );

    expect(screen.getByText(/跟随实时尾部/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "暂停跟随" }));
    expect(onToggleLiveUpdates).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "锁定布局" }));
    expect(onSetLayoutLocked).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: "紧凑排列" }));
    expect(onSetCompactType).toHaveBeenCalledWith(null);

    await user.click(screen.getByRole("button", { name: "重置布局" }));
    expect(onResetLayout).toHaveBeenCalledWith(workspace.selectedDashboardId);

    workspace = { ...workspace, layoutLocked: true, compactType: null };
    rerender(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          jointStateTopic: "/js",
          liveUpdates: false,
          onToggleLiveUpdates,
          onSetLayoutLocked,
          onSetCompactType,
          onResetLayout,
        })}
      />,
    );
    expect(screen.getByText(/已暂停（采样与窗口均冻结）/)).toBeVisible();
    expect(screen.getByText(/布局已锁定/)).toBeVisible();
    expect(screen.getByRole("button", { name: "解锁布局" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "紧凑排列" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "跟随实时" })).toBeVisible();
  });

  it("maximizes a panel on double-click and restores via button", async () => {
    const user = userEvent.setup();
    const workspace = createDefaultMonitorWorkspace("/js");
    const panel = workspace.dashboards[0]!.panels[0]!;
    render(<MonitorPage workspace={workspace} {...baseProps({ jointStateTopic: "/js" })} />);

    expect(screen.getByLabelText("effort[6] 曲线")).toBeVisible();
    const handles = screen.getAllByTitle(/双击最大化/);
    fireEvent.doubleClick(handles[0]!);

    expect(screen.getByText(/最大化 · effort\[0\]/)).toBeVisible();
    expect(screen.queryByLabelText("effort[6] 曲线")).not.toBeInTheDocument();
    expect(screen.getByLabelText("effort[0] 曲线")).toBeVisible();
    expect(panel.title).toBe("effort[0]");

    await user.click(screen.getByRole("button", { name: "恢复网格" }));
    expect(screen.getByLabelText("effort[6] 曲线")).toBeVisible();
    expect(screen.queryByText(/最大化 ·/)).not.toBeInTheDocument();
  });

  it("keeps remove available in a maximized Panel", async () => {
    const onRemovePanel = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    const panel = workspace.dashboards[0]!.panels[0]!;
    render(<MonitorPage workspace={workspace} {...baseProps({ jointStateTopic: "/js", onRemovePanel })} />);

    fireEvent.doubleClick(screen.getAllByTitle(/双击最大化/)[0]!);
    fireEvent.click(screen.getByRole("button", { name: "移除 effort[0]" }));
    expect(onRemovePanel).toHaveBeenCalledWith(workspace.selectedDashboardId, panel.id);
  });

  it("allows changing each Panel chart type and its rendering option", async () => {
    const user = userEvent.setup();
    const onUpdatePanelChart = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    const panel = workspace.dashboards[0]!.panels[0]!;
    const { rerender } = render(<MonitorPage workspace={workspace} {...baseProps({ jointStateTopic: "/js", onUpdatePanelChart })} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "effort[0] 图表类型" }), "bar");
    expect(onUpdatePanelChart).toHaveBeenCalledWith(workspace.selectedDashboardId, panel.id, { type: "bar" });
    const changed = { ...workspace, dashboards: [{ ...workspace.dashboards[0]!, panels: [{ ...panel, chart: { ...panel.chart, type: "bar" as const } }, ...workspace.dashboards[0]!.panels.slice(1)] }] };
    rerender(<MonitorPage workspace={changed} {...baseProps({ jointStateTopic: "/js", onUpdatePanelChart })} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "effort[0] 条形方向" }), "horizontal");
    expect(onUpdatePanelChart).toHaveBeenCalledWith(workspace.selectedDashboardId, panel.id, { barOrientation: "horizontal" });
  });

  it("does not call onLayoutChange while layout is locked", () => {
    const onLayoutChange = vi.fn();
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = {
      ...workspace,
      layoutLocked: true,
    };
    // scramble then lock — page should ignore layout events when locked
    workspace = updateDashboardLayout(workspace, workspace.selectedDashboardId, [
      { i: workspace.dashboards[0]!.panels[0]!.id, x: 0, y: 0, w: 6, h: 3 },
    ]);
    render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({ jointStateTopic: "/js", onLayoutChange })}
      />,
    );
    expect(screen.getByText(/布局已锁定/)).toBeVisible();
    expect(onLayoutChange).not.toHaveBeenCalled();
  });


  it("saves and loads layout presets from the toolbar", async () => {
    const user = userEvent.setup();
    let workspace = createDefaultMonitorWorkspace("/js");
    const onApplyWorkspace = vi.fn((next) => {
      workspace = next;
    });
    const { rerender } = render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({ jointStateTopic: "/js", onApplyWorkspace })}
      />,
    );
    await user.type(screen.getByLabelText("布局预设名称"), "我的布局");
    await user.click(screen.getByRole("button", { name: "保存布局" }));
    expect(screen.getByText(/已保存布局「我的布局」/)).toBeVisible();
    expect(screen.getByTitle("加载布局 我的布局")).toBeVisible();

    workspace = addMonitorDashboard(workspace, createEmptyDashboard("Empty", "dash-empty"));
    rerender(
      <MonitorPage
        workspace={workspace}
        {...baseProps({ jointStateTopic: "/js", onApplyWorkspace })}
      />,
    );
    await user.click(screen.getByTitle("加载布局 我的布局"));
    expect(onApplyWorkspace).toHaveBeenCalled();
    expect(onApplyWorkspace.mock.calls.at(-1)![0].dashboards.find((d: { id: string }) => d.id === "dash-empty").panels).toHaveLength(7);
  });

  it("shows bag playbar with pause and 1x controls while playing", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onStart = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    render(
      <MonitorPage
        workspace={workspace}
        {...baseProps({
          jointStateTopic: "/js",
          bagStatus: { playing: true, pid: 9, bagPath: "robot-console-bags/demo", message: "playing" },
          bagClockMs: 20_000,
          bagOriginMs: 10_000,
          bagWallStartedAtMs: 100,
          onStopBagPlay: onStop,
          onStartBagPlay: onStart,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Bag 回放" }));
    expect(screen.getByRole("group", { name: "回放控制条" })).toBeVisible();
    expect(screen.getByRole("button", { name: "播放 1x" })).toBeDisabled();
    expect(screen.getByText("1x")).toBeVisible();
    expect(screen.getByLabelText("已播放时长")).toHaveTextContent("0:10");
    expect(screen.getAllByText(/时间轴：bag/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
