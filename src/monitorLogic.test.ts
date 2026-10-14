import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_PANEL_NAME,
  DEFAULT_TORQUE_JOINT_COUNT,
  MONITOR_STORAGE_KEY,
  addMonitorPanel,
  createDefaultMonitorWorkspace,
  createEmptyPanel,
  createTorquePanel,
  createTorqueSeries,
  deleteMonitorPanel,
  hydrateMonitorWorkspace,
  isSafeBagPath,
  loadMonitorWorkspace,
  panelHasSeries,
  persistMonitorWorkspace,
  renameMonitorPanel,
  saveMonitorWorkspace,
  selectMonitorPanel,
  selectedMonitorPanel,
  updateMonitorFromMessage,
  updatePanelSeries,
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

describe("monitorLogic persistence and helpers", () => {
  it("loads and saves workspace through Storage without points", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = addMonitorPanel(workspace, createEmptyPanel("Custom", "panel-custom"));
    saveMonitorWorkspace(workspace, storage);
    expect(store.get(MONITOR_STORAGE_KEY)).toContain("Custom");

    const loaded = loadMonitorWorkspace("/js", storage);
    expect(loaded.panels).toHaveLength(2);
    expect(loaded.panels.map((panel) => panel.name)).toEqual(["Motor Torque", "Custom"]);
    expect(loaded.panels.every((panel) => panel.series.every((series) => series.points.length === 0))).toBe(true);
    expect(loaded.selectedPanelId).toBe("panel-custom");
  });

  it("falls back to torque default on missing, empty, or corrupt storage", () => {
    expect(loadMonitorWorkspace("/js", { getItem: () => null }).panels[0]!.name).toBe(DEFAULT_MONITOR_PANEL_NAME);
    expect(loadMonitorWorkspace("/js", { getItem: () => "not-json{" }).panels[0]!.series).toHaveLength(7);
    expect(hydrateMonitorWorkspace(null, "/js").panels).toHaveLength(1);
    expect(hydrateMonitorWorkspace({ panels: [], selectedPanelId: "x" }, "/js").panels[0]!.name)
      .toBe(DEFAULT_MONITOR_PANEL_NAME);
  });

  it("repairs missing panel ids and unknown selectedPanelId on hydrate", () => {
    const hydrated = hydrateMonitorWorkspace({
      selectedPanelId: "missing",
      panels: [
        { id: "", name: "  ", series: [{ topic: "/a", fieldPath: "x", color: "#abc" }] },
        { id: "keep", name: "Keep", series: [] },
      ],
    }, "/js");
    expect(hydrated.panels[0]!.id).toBe("panel-0");
    expect(hydrated.panels[0]!.name).toBe("Panel 1");
    expect(hydrated.panels[0]!.series[0]).toMatchObject({ topic: "/a", fieldPath: "x", color: "#abc", points: [] });
    expect(hydrated.selectedPanelId).toBe("panel-0");
  });

  it("updates panel series, detects duplicates, and ignores unknown select", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const panelId = workspace.selectedPanelId;
    expect(panelHasSeries(workspace.panels[0]!, "/js", "effort[0]")).toBe(true);
    expect(panelHasSeries(workspace.panels[0]!, "/js", "position[0]")).toBe(false);

    const emptied = updatePanelSeries(workspace, panelId, []);
    expect(emptied.panels[0]!.series).toEqual([]);
    expect(updatePanelSeries(workspace, "nope", []).panels[0]!.series).toHaveLength(7);

    expect(selectMonitorPanel(workspace, "nope")).toBe(workspace);
    expect(selectedMonitorPanel({ panels: [], selectedPanelId: "x" })).toBeUndefined();
  });

  it("skips empty panels during live updates", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = addMonitorPanel(workspace, createEmptyPanel("Empty"));
    const next = updateMonitorFromMessage(workspace, "/js", { effort: [1, 2, 3, 4, 5, 6, 7] }, 10);
    expect(next.panels.find((panel) => panel.name === "Empty")!.series).toEqual([]);
    expect(next.panels.find((panel) => panel.name === DEFAULT_MONITOR_PANEL_NAME)!.series[0]!.points)
      .toEqual([{ t: 10, value: 1 }]);
  });

  it("rejects overlong and dashed-segment bag paths", () => {
    expect(isSafeBagPath(`bags/${"a".repeat(4100)}`)).toBe(false);
    expect(isSafeBagPath("bags/-bad")).toBe(false);
    expect(isSafeBagPath("/")).toBe(false);
    expect(isSafeBagPath("bags/./nested")).toBe(false);
  });
});
