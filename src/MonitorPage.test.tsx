import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MonitorPage } from "./MonitorPage";
import { createDefaultMonitorWorkspace, createEmptyPanel, addMonitorPanel } from "./monitorLogic";

describe("MonitorPage", () => {
  it("renders default torque panel and supports create/rename/delete", async () => {
    const user = userEvent.setup();
    let workspace = createDefaultMonitorWorkspace("/stm32/joint_states");
    const onSelectPanel = vi.fn((id: string) => {
      workspace = { ...workspace, selectedPanelId: id };
    });
    const onAddPanel = vi.fn((panel) => {
      workspace = addMonitorPanel(workspace, panel);
    });
    const onRenamePanel = vi.fn();
    const onDeletePanel = vi.fn();
    const { rerender } = render(
      <MonitorPage
        workspace={workspace}
        jointStateTopic="/stm32/joint_states"
        liveUpdates
        bagStatus={null}
        bagBusy={false}
        bagNotice=""
        onSelectPanel={onSelectPanel}
        onAddPanel={onAddPanel}
        onRenamePanel={onRenamePanel}
        onDeletePanel={onDeletePanel}
        onUpdatePanelSeries={() => undefined}
        onRefreshBagStatus={() => undefined}
        onStartBagPlay={() => undefined}
        onStopBagPlay={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { name: "Monitor" })).toBeVisible();
    expect(screen.getByRole("tab", { name: /Motor Torque/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("effort 独立曲线网格")).toBeVisible();
    expect(screen.getByLabelText("effort[0] 曲线")).toBeVisible();
    expect(screen.getByLabelText("effort[6] 曲线")).toBeVisible();
    expect(screen.getByText(/7 路 effort 独立图/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "新建空面板" }));
    expect(onAddPanel).toHaveBeenCalled();
    workspace = addMonitorPanel(workspace, createEmptyPanel("Custom"));
    rerender(
      <MonitorPage
        workspace={workspace}
        jointStateTopic="/stm32/joint_states"
        liveUpdates
        bagStatus={null}
        bagBusy={false}
        bagNotice=""
        onSelectPanel={onSelectPanel}
        onAddPanel={onAddPanel}
        onRenamePanel={onRenamePanel}
        onDeletePanel={onDeletePanel}
        onUpdatePanelSeries={() => undefined}
        onRefreshBagStatus={() => undefined}
        onStartBagPlay={() => undefined}
        onStopBagPlay={() => undefined}
      />,
    );
    const name = screen.getByLabelText("面板名称");
    await user.clear(name);
    await user.type(name, "My Panel");
    await user.tab();
    expect(onRenamePanel).toHaveBeenCalledWith(workspace.selectedPanelId, "My Panel");

    await user.click(screen.getByRole("button", { name: /删除面板/ }));
    expect(onDeletePanel).toHaveBeenCalledWith(workspace.selectedPanelId);
  });

  it("validates bag path before starting playback", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    render(
      <MonitorPage
        workspace={workspace}
        jointStateTopic="/js"
        liveUpdates
        bagStatus={null}
        bagBusy={false}
        bagNotice=""
        onSelectPanel={() => undefined}
        onAddPanel={() => undefined}
        onRenamePanel={() => undefined}
        onDeletePanel={() => undefined}
        onUpdatePanelSeries={() => undefined}
        onRefreshBagStatus={() => undefined}
        onStartBagPlay={onStart}
        onStopBagPlay={() => undefined}
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
});

  it("adds a torque template panel and switches tabs", async () => {
    const user = userEvent.setup();
    let workspace = createDefaultMonitorWorkspace("/stm32/joint_states");
    const torqueId = workspace.selectedPanelId;
    const onSelectPanel = vi.fn();
    const onAddPanel = vi.fn();
    const props = {
      jointStateTopic: "/stm32/joint_states",
      liveUpdates: true,
      bagStatus: null as null,
      bagBusy: false,
      bagNotice: "",
      onSelectPanel,
      onAddPanel,
      onRenamePanel: () => undefined,
      onDeletePanel: () => undefined,
      onUpdatePanelSeries: () => undefined,
      onRefreshBagStatus: () => undefined,
      onStartBagPlay: () => undefined,
      onStopBagPlay: () => undefined,
    };
    const { rerender } = render(<MonitorPage workspace={workspace} {...props} />);

    await user.click(screen.getByRole("button", { name: "添加力矩模板面板" }));
    expect(onAddPanel).toHaveBeenCalledWith(expect.objectContaining({
      name: "Motor Torque",
      series: expect.arrayContaining([
        expect.objectContaining({ fieldPath: "effort[0]", topic: "/stm32/joint_states" }),
        expect.objectContaining({ fieldPath: "effort[6]" }),
      ]),
    }));
    expect(onAddPanel.mock.calls[0]![0].series).toHaveLength(7);

    workspace = addMonitorPanel(workspace, createEmptyPanel("Second", "panel-second"));
    rerender(<MonitorPage workspace={workspace} {...props} />);
    expect(screen.getByRole("tab", { name: /Second/ })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: /Motor Torque/ }));
    expect(onSelectPanel).toHaveBeenCalledWith(torqueId);
  });

  it("clears and removes series through DataGraph and stops bag playback", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onStop = vi.fn();
    const onRefresh = vi.fn();
    const workspace = createDefaultMonitorWorkspace("/js");
    render(
      <MonitorPage
        workspace={workspace}
        jointStateTopic="/js"
        liveUpdates={false}
        bagStatus={{ playing: true, pid: 123, bagPath: "robot-console-bags/demo", message: "playing" }}
        bagBusy={false}
        bagNotice="note"
        onSelectPanel={() => undefined}
        onAddPanel={() => undefined}
        onRenamePanel={() => undefined}
        onDeletePanel={() => undefined}
        onUpdatePanelSeries={onUpdate}
        onRefreshBagStatus={onRefresh}
        onStartBagPlay={() => undefined}
        onStopBagPlay={onStop}
      />,
    );

    expect(screen.getAllByText(/已暂停/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "移除 effort[0]" }));
    expect(onUpdate).toHaveBeenCalledWith(workspace.selectedPanelId, expect.any(Array));
    expect(onUpdate.mock.calls[0]![1]).toHaveLength(6);

    await user.click(screen.getByRole("button", { name: "清空曲线" }));
    expect(onUpdate).toHaveBeenLastCalledWith(workspace.selectedPanelId, []);

    await user.click(screen.getByRole("button", { name: "Bag 回放" }));
    expect(screen.getByText("note")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "刷新状态" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "停止回放" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
