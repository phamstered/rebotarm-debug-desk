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
    expect(screen.getByText(/7 条曲线/)).toBeVisible();

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
