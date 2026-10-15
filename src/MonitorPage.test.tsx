import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MonitorPage } from "./MonitorPage";
import {
  addMonitorDashboard,
  createDefaultMonitorWorkspace,
  createEmptyDashboard,
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
    onClearPanels: () => undefined,
    onRefreshBagStatus: () => undefined,
    onStartBagPlay: () => undefined,
    onStopBagPlay: () => undefined,
    ...overrides,
  };
}

describe("MonitorPage", () => {
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

  it("removes panels through DataGraph and stops bag playback", async () => {
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
});
