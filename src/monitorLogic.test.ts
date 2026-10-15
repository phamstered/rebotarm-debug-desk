import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_DASHBOARD_NAME,
  DEFAULT_MONITOR_PANEL_NAME,
  DEFAULT_TORQUE_JOINT_COUNT,
  MONITOR_STORAGE_KEY,
  MONITOR_STORAGE_VERSION,
  addMonitorDashboard,
  addPanelsToDashboard,
  clearDashboardPanels,
  createDefaultMonitorWorkspace,
  createEmptyDashboard,
  createTorqueDashboard,
  createTorqueSeries,
  deleteMonitorDashboard,
  hydrateMonitorWorkspace,
  isSafeBagPath,
  loadMonitorWorkspace,
  migrateV1PanelToDashboard,
  packPanelLayouts,
  panelHasSeries,
  persistMonitorWorkspace,
  removePanelFromDashboard,
  renameMonitorDashboard,
  saveMonitorWorkspace,
  selectMonitorDashboard,
  selectedMonitorDashboard,
  updateDashboardLayout,
  updateMonitorFromMessage,
  updatePanelSeries,
} from "./monitorLogic";

describe("monitorLogic torque dashboard", () => {
  it("builds effort[0..n) series on the joint-state topic", () => {
    const series = createTorqueSeries("/stm32/joint_states", 7);
    expect(series).toHaveLength(DEFAULT_TORQUE_JOINT_COUNT);
    expect(series.map((entry) => entry.fieldPath)).toEqual([
      "effort[0]", "effort[1]", "effort[2]", "effort[3]", "effort[4]", "effort[5]", "effort[6]",
    ]);
    expect(series.every((entry) => entry.topic === "/stm32/joint_states")).toBe(true);
    expect(series.every((entry) => entry.points.length === 0)).toBe(true);
  });

  it("creates a default workspace with Motor Torque dashboard of 7 panels", () => {
    const workspace = createDefaultMonitorWorkspace("/stm32/joint_states");
    expect(workspace.dashboards).toHaveLength(1);
    const dashboard = workspace.dashboards[0]!;
    expect(dashboard.name).toBe(DEFAULT_MONITOR_DASHBOARD_NAME);
    expect(dashboard.name).toBe(DEFAULT_MONITOR_PANEL_NAME);
    expect(workspace.selectedDashboardId).toBe(dashboard.id);
    expect(dashboard.panels).toHaveLength(7);
    expect(dashboard.panels.map((panel) => panel.series.fieldPath)).toEqual([
      "effort[0]", "effort[1]", "effort[2]", "effort[3]", "effort[4]", "effort[5]", "effort[6]",
    ]);
    expect(dashboard.panels[0]!.layout).toMatchObject({ x: 0, y: 0, w: 4, h: 2 });
    expect(dashboard.panels[1]!.layout).toMatchObject({ x: 4, y: 0, w: 4, h: 2 });
    expect(dashboard.panels[2]!.layout).toMatchObject({ x: 8, y: 0, w: 4, h: 2 });
    expect(dashboard.panels[3]!.layout).toMatchObject({ x: 0, y: 2, w: 4, h: 2 });
    expect(dashboard.panels[6]!.layout).toMatchObject({ x: 0, y: 4, w: 4, h: 2 });
    expect(dashboard.panels.every((panel) => panel.layout.i === panel.id)).toBe(true);
  });

  it("packs layouts in a 12-col grid", () => {
    const layouts = packPanelLayouts(4, (index) => `p${index}`);
    expect(layouts).toEqual([
      { i: "p0", x: 0, y: 0, w: 4, h: 2 },
      { i: "p1", x: 4, y: 0, w: 4, h: 2 },
      { i: "p2", x: 8, y: 0, w: 4, h: 2 },
      { i: "p3", x: 0, y: 2, w: 4, h: 2 },
    ]);
  });
});

describe("monitorLogic dashboard CRUD", () => {
  it("selects, renames, adds and deletes dashboards; last delete restores torque default", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const torqueId = workspace.selectedDashboardId;
    const extra = createEmptyDashboard("Custom");
    workspace = addMonitorDashboard(workspace, extra);
    expect(workspace.selectedDashboardId).toBe(extra.id);
    expect(workspace.dashboards).toHaveLength(2);

    workspace = selectMonitorDashboard(workspace, torqueId);
    expect(workspace.selectedDashboardId).toBe(torqueId);
    workspace = renameMonitorDashboard(workspace, torqueId, "  Torques  ");
    expect(selectedMonitorDashboard(workspace)?.name).toBe("Torques");
    expect(renameMonitorDashboard(workspace, torqueId, "   ")).toBe(workspace);

    workspace = deleteMonitorDashboard(workspace, torqueId, "/js");
    expect(workspace.dashboards).toHaveLength(1);
    expect(workspace.dashboards[0]!.id).toBe(extra.id);

    workspace = deleteMonitorDashboard(workspace, extra.id, "/js");
    expect(workspace.dashboards).toHaveLength(1);
    expect(workspace.dashboards[0]!.name).toBe(DEFAULT_MONITOR_DASHBOARD_NAME);
    expect(createTorqueDashboard("/js").panels).toHaveLength(7);
  });

  it("round-trips persistence without points and writes version 2", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = updateMonitorFromMessage(
      workspace,
      "/js",
      { effort: [1, 2, 3, 4, 5, 6, 7] },
      50,
    );
    expect(workspace.dashboards[0]!.panels[0]!.series.points.length).toBe(1);
    const persisted = persistMonitorWorkspace(workspace);
    expect(persisted.version).toBe(MONITOR_STORAGE_VERSION);
    expect(persisted.dashboards[0]!.panels[0]!.series).toMatchObject({
      topic: "/js",
      fieldPath: "effort[0]",
    });
    expect(persisted.dashboards[0]!.panels[0]!.layout.w).toBe(4);
    const hydrated = hydrateMonitorWorkspace(persisted, "/js");
    expect(hydrated.dashboards[0]!.panels.every((panel) => panel.series.points.length === 0)).toBe(true);
    expect(hydrated.selectedDashboardId).toBe(persisted.selectedDashboardId);
  });
});

describe("monitorLogic live updates and bag path", () => {
  it("updates matching panel series from a message", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    const next = updateMonitorFromMessage(workspace, "/js", { effort: [10, 20, 30, 40, 50, 60, 70] }, 1_000);
    expect(next).not.toBe(workspace);
    expect(next.dashboards[0]!.panels[0]!.series.points).toEqual([{ t: 1_000, value: 10 }]);
    expect(next.dashboards[0]!.panels[6]!.series.points).toEqual([{ t: 1_000, value: 70 }]);
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

describe("monitorLogic persistence migration and helpers", () => {
  it("loads and saves workspace through Storage without points", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = addMonitorDashboard(workspace, createEmptyDashboard("Custom", "dashboard-custom"));
    saveMonitorWorkspace(workspace, storage);
    expect(store.get(MONITOR_STORAGE_KEY)).toContain("Custom");
    expect(store.get(MONITOR_STORAGE_KEY)).toContain('"version":2');

    const loaded = loadMonitorWorkspace("/js", storage);
    expect(loaded.dashboards).toHaveLength(2);
    expect(loaded.dashboards.map((dashboard) => dashboard.name)).toEqual(["Motor Torque", "Custom"]);
    expect(loaded.dashboards.every((dashboard) =>
      dashboard.panels.every((panel) => panel.series.points.length === 0))).toBe(true);
    expect(loaded.selectedDashboardId).toBe("dashboard-custom");
  });

  it("falls back to torque default on missing, empty, or corrupt storage", () => {
    expect(loadMonitorWorkspace("/js", { getItem: () => null }).dashboards[0]!.name)
      .toBe(DEFAULT_MONITOR_DASHBOARD_NAME);
    expect(loadMonitorWorkspace("/js", { getItem: () => "not-json{" }).dashboards[0]!.panels)
      .toHaveLength(7);
    expect(hydrateMonitorWorkspace(null, "/js").dashboards).toHaveLength(1);
    expect(hydrateMonitorWorkspace({
      version: 2,
      dashboards: [],
      selectedDashboardId: "x",
    }, "/js").dashboards[0]!.name).toBe(DEFAULT_MONITOR_DASHBOARD_NAME);
  });

  it("migrates v1 panels[].series[] tabs into dashboards with one panel per series", () => {
    const hydrated = hydrateMonitorWorkspace({
      selectedPanelId: "tab-torque",
      panels: [
        {
          id: "tab-torque",
          name: "Motor Torque",
          series: [
            { topic: "/js", fieldPath: "effort[0]", color: "#a" },
            { topic: "/js", fieldPath: "effort[1]", color: "#b" },
          ],
        },
        { id: "tab-empty", name: "Empty", series: [] },
      ],
    }, "/js");
    expect(hydrated.dashboards).toHaveLength(2);
    expect(hydrated.selectedDashboardId).toBe("tab-torque");
    expect(hydrated.dashboards[0]!.panels).toHaveLength(2);
    expect(hydrated.dashboards[0]!.panels[0]!.series).toMatchObject({
      topic: "/js",
      fieldPath: "effort[0]",
      color: "#a",
      points: [],
    });
    expect(hydrated.dashboards[0]!.panels[0]!.layout).toMatchObject({ x: 0, y: 0, w: 4, h: 2 });
    expect(hydrated.dashboards[0]!.panels[1]!.layout).toMatchObject({ x: 4, y: 0, w: 4, h: 2 });
    expect(hydrated.dashboards[1]!.panels).toHaveLength(0);
    expect(migrateV1PanelToDashboard({
      id: "x",
      name: "X",
      series: [{ topic: "/t", fieldPath: "a", color: "#1" }],
    }, 0).panels).toHaveLength(1);
  });

  it("repairs missing dashboard ids and unknown selectedDashboardId on hydrate", () => {
    const hydrated = hydrateMonitorWorkspace({
      version: 2,
      selectedDashboardId: "missing",
      dashboards: [
        {
          id: "",
          name: "  ",
          panels: [{
            id: "",
            title: "",
            layout: { i: "", x: 1, y: 2, w: 6, h: 3 },
            series: { topic: "/a", fieldPath: "x", color: "#abc" },
          }],
        },
        { id: "keep", name: "Keep", panels: [] },
      ],
    }, "/js");
    expect(hydrated.dashboards[0]!.id).toBe("dashboard-0");
    expect(hydrated.dashboards[0]!.name).toBe("Dashboard 1");
    expect(hydrated.dashboards[0]!.panels[0]!.id).toBe("panel-0");
    expect(hydrated.dashboards[0]!.panels[0]!.series).toMatchObject({
      topic: "/a",
      fieldPath: "x",
      color: "#abc",
      points: [],
    });
    expect(hydrated.selectedDashboardId).toBe("dashboard-0");
  });

  it("updates layout, adds/removes panels, and ignores unknown select", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const dashboardId = workspace.selectedDashboardId;
    expect(panelHasSeries(workspace.dashboards[0]!, "/js", "effort[0]")).toBe(true);
    expect(panelHasSeries(workspace.dashboards[0]!, "/js", "position[0]")).toBe(false);

    const panelId = workspace.dashboards[0]!.panels[0]!.id;
    workspace = updateDashboardLayout(workspace, dashboardId, [
      { i: panelId, x: 2, y: 4, w: 6, h: 3 },
    ]);
    expect(workspace.dashboards[0]!.panels[0]!.layout).toMatchObject({ x: 2, y: 4, w: 6, h: 3 });

    const emptied = clearDashboardPanels(workspace, dashboardId);
    expect(emptied.dashboards[0]!.panels).toEqual([]);

    const withExtra = addPanelsToDashboard(workspace, dashboardId, [
      createTorqueSeries("/js", 1)[0]!,
    ]);
    // effort[0] already exists — no duplicate
    expect(withExtra.dashboards[0]!.panels).toHaveLength(7);

    const custom = createTorqueSeries("/other", 1)[0]!;
    const added = addPanelsToDashboard(workspace, dashboardId, [custom]);
    expect(added.dashboards[0]!.panels).toHaveLength(8);
    expect(added.dashboards[0]!.panels[7]!.series.topic).toBe("/other");
    expect(added.dashboards[0]!.panels[7]!.layout.y).toBeGreaterThanOrEqual(6);

    const removed = removePanelFromDashboard(added, dashboardId, added.dashboards[0]!.panels[7]!.id);
    expect(removed.dashboards[0]!.panels).toHaveLength(7);

    expect(updatePanelSeries(workspace, "nope", []).dashboards[0]!.panels).toHaveLength(7);
    expect(selectMonitorDashboard(workspace, "nope")).toBe(workspace);
    expect(selectedMonitorDashboard({ dashboards: [], selectedDashboardId: "x" })).toBeUndefined();
  });

  it("skips empty dashboards during live updates", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    workspace = addMonitorDashboard(workspace, createEmptyDashboard("Empty"));
    const next = updateMonitorFromMessage(workspace, "/js", { effort: [1, 2, 3, 4, 5, 6, 7] }, 10);
    expect(next.dashboards.find((dashboard) => dashboard.name === "Empty")!.panels).toEqual([]);
    expect(next.dashboards.find((dashboard) => dashboard.name === DEFAULT_MONITOR_DASHBOARD_NAME)!
      .panels[0]!.series.points).toEqual([{ t: 10, value: 1 }]);
  });

  it("rejects overlong and dashed-segment bag paths", () => {
    expect(isSafeBagPath(`bags/${"a".repeat(4100)}`)).toBe(false);
    expect(isSafeBagPath("bags/-bad")).toBe(false);
    expect(isSafeBagPath("/")).toBe(false);
    expect(isSafeBagPath("bags/./nested")).toBe(false);
  });
});
