import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_PANEL_NAME,
  DEFAULT_TORQUE_JOINT_COUNT,
  addMonitorPanel,
  createDefaultMonitorWorkspace,
  createEmptyPanel,
  createTorquePanel,
  createTorqueSeries,
  deleteMonitorPanel,
  hydrateMonitorWorkspace,
  isSafeBagPath,
  persistMonitorWorkspace,
  renameMonitorPanel,
  selectMonitorPanel,
  selectedMonitorPanel,
  updateMonitorFromMessage,
} from "./monitorLogic";

describe("monitorLogic torque template", () => {
  it("builds effort[0..n) series on the joint-state topic", () => {
    const series = createTorqueSeries("/stm32/joint_states", 7);
    expect(series).toHaveLength(DEFAULT_TORQUE_JOINT_COUNT);
    expect(series.map((entry) => entry.fieldPath)).toEqual([
      "effort[0]", "effort[1]", "effort[2]", "effort[3]", "effort[4]", "effort[5]", "effort[6]",
    ]);
    expect(series.every((entry) => entry.topic === "/stm32/joint_states")).toBe(true);
    expect(series.every((entry) => entry.points.length === 0)).toBe(true);
  });

  it("creates a default workspace with Motor Torque selected", () => {
    const workspace = createDefaultMonitorWorkspace("/stm32/joint_states");
    expect(workspace.panels).toHaveLength(1);
    expect(workspace.panels[0]!.name).toBe(DEFAULT_MONITOR_PANEL_NAME);
    expect(workspace.selectedPanelId).toBe(workspace.panels[0]!.id);
    expect(workspace.panels[0]!.series).toHaveLength(7);
  });
});

describe("monitorLogic panel CRUD", () => {
  it("selects, renames, adds and deletes panels; last delete restores torque default", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const torqueId = workspace.selectedPanelId;
    const extra = createEmptyPanel("Custom");
    workspace = addMonitorPanel(workspace, extra);
    expect(workspace.selectedPanelId).toBe(extra.id);
    expect(workspace.panels).toHaveLength(2);

    workspace = selectMonitorPanel(workspace, torqueId);
    expect(workspace.selectedPanelId).toBe(torqueId);
    workspace = renameMonitorPanel(workspace, torqueId, "  Torques  ");
    expect(selectedMonitorPanel(workspace)?.name).toBe("Torques");
    expect(renameMonitorPanel(workspace, torqueId, "   ")).toBe(workspace);

    workspace = deleteMonitorPanel(workspace, torqueId, "/js");
    expect(workspace.panels).toHaveLength(1);
    expect(workspace.panels[0]!.id).toBe(extra.id);

    workspace = deleteMonitorPanel(workspace, extra.id, "/js");
    expect(workspace.panels).toHaveLength(1);
    expect(workspace.panels[0]!.name).toBe(DEFAULT_MONITOR_PANEL_NAME);
    expect(createTorquePanel("/js").series).toHaveLength(7);
  });

  it("round-trips persistence without points", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = updateMonitorFromMessage(
      workspace,
      "/js",
      { effort: [1, 2, 3, 4, 5, 6, 7] },
      50,
    );
    expect(workspace.panels[0]!.series[0]!.points.length).toBe(1);
    const persisted = persistMonitorWorkspace(workspace);
    expect(persisted.panels[0]!.series[0]).toMatchObject({ topic: "/js", fieldPath: "effort[0]" });
    const hydrated = hydrateMonitorWorkspace(persisted, "/js");
    expect(hydrated.panels[0]!.series.every((series) => series.points.length === 0)).toBe(true);
    expect(hydrated.selectedPanelId).toBe(persisted.selectedPanelId);
  });
});

describe("monitorLogic live updates and bag path", () => {
  it("updates matching panel series from a message", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    const next = updateMonitorFromMessage(workspace, "/js", { effort: [10, 20, 30, 40, 50, 60, 70] }, 1_000);
    expect(next).not.toBe(workspace);
    expect(next.panels[0]!.series[0]!.points).toEqual([{ t: 1_000, value: 10 }]);
    expect(updateMonitorFromMessage(next, "/other", { effort: [1] }, 1_100)).toBe(next);
  });

  it("validates remote bag paths like ROS setup scripts", () => {
    expect(isSafeBagPath("robot-console-bags/run-1")).toBe(true);
    expect(isSafeBagPath("/home/robot/robot-console-bags/run")).toBe(true);
    expect(isSafeBagPath("")).toBe(false);
    expect(isSafeBagPath("../etc/passwd")).toBe(false);
    expect(isSafeBagPath("bags/$(reboot)")).toBe(false);
    expect(isSafeBagPath("-rf")).toBe(false);
  });
});
