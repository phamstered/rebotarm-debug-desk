import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_DASHBOARD_NAME,
  DEFAULT_MONITOR_PANEL_NAME,
  DEFAULT_TORQUE_JOINT_COUNT,
  MONITOR_LAYOUT_PRESETS_KEY,
  MONITOR_STORAGE_KEY,
  MONITOR_STORAGE_VERSION,
  addMonitorDashboard,
  addPanelsToDashboard,
  addSeriesToDashboardPanel,
  applyLayoutPresetToDashboard,
  clearDashboardPanels,
  createDefaultMonitorWorkspace,
  createEmptyDashboard,
  createLayoutPresetFromDashboard,
  createTorqueDashboard,
  createTorqueSeries,
  deleteLayoutPreset,
  deleteMonitorDashboard,
  exportLayoutPresetsJson,
  hydrateLayoutPresetBundle,
  hydrateMonitorWorkspace,
  importLayoutPresetsJson,
  isSafeBagPath,
  loadLayoutPresets,
  loadMonitorWorkspace,
  migrateV1PanelToDashboard,
  packPanelLayouts,
  panelHasSeries,
  persistMonitorWorkspace,
  removePanelFromDashboard,
  renameMonitorDashboard,
  resetDashboardPanelLayouts,
  saveLayoutPresets,
  saveMonitorWorkspace,
  selectMonitorDashboard,
  selectedMonitorDashboard,
  setMonitorCompactType,
  setMonitorLayoutLocked,
  updateDashboardLayout,
  updateMonitorFromMessage,
  updatePanelChart,
  updatePanelSeries,
  upsertLayoutPreset,
} from "./monitorLogic";

describe("monitorLogic torque dashboard", () => {
  it("adds an array into one new Panel, then deduplicates fields in an existing Panel", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    const dashboardId = workspace.selectedDashboardId;
    const fields = createTorqueSeries("/sensor", 2);
    const created = addSeriesToDashboardPanel(workspace, dashboardId, null, fields);
    const panel = created.dashboards[0]!.panels.at(-1)!;
    expect(panel.series.fieldPath).toBe("effort[0]");
    expect(panel.additionalSeries.map((series) => series.fieldPath)).toEqual(["effort[1]"]);
    const duplicate = addSeriesToDashboardPanel(created, dashboardId, panel.id, [fields[1]!, fields[1]!]);
    expect(duplicate.dashboards[0]!.panels.at(-1)!.additionalSeries).toHaveLength(1);
    const next = updateMonitorFromMessage(duplicate, "/sensor", { effort: [4, 8] }, 1_000);
    expect(next.dashboards[0]!.panels.at(-1)!.additionalSeries[0]!.points).toEqual([{ t: 1_000, value: 8 }]);
    expect(addSeriesToDashboardPanel(workspace, "missing", null, fields)).toBe(workspace);
  });

  it("persists multi-series chart settings and migrates an older single-series Panel", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const dashboardId = workspace.selectedDashboardId;
    const panelId = workspace.dashboards[0]!.panels[0]!.id;
    workspace = addSeriesToDashboardPanel(workspace, dashboardId, panelId, createTorqueSeries("/sensor", 1));
    workspace = updatePanelChart(workspace, dashboardId, panelId, { type: "gauge", gaugeMin: -10, gaugeMax: 10, gaugeThreshold: 7 });
    const persisted = persistMonitorWorkspace(workspace);
    const restored = hydrateMonitorWorkspace(persisted, "/js");
    expect(restored.dashboards[0]!.panels[0]!.additionalSeries).toHaveLength(1);
    expect(restored.dashboards[0]!.panels[0]!.chart).toMatchObject({ type: "gauge", gaugeMin: -10, gaugeMax: 10, gaugeThreshold: 7 });
    const old = structuredClone(persisted);
    delete old.dashboards[0]!.panels[0]!.additionalSeries;
    delete old.dashboards[0]!.panels[0]!.chart;
    expect(hydrateMonitorWorkspace(old, "/js").dashboards[0]!.panels[0]!.chart.type).toBe("time-series");
  });
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
    expect(selectedMonitorDashboard({
      dashboards: [],
      selectedDashboardId: "x",
      layoutLocked: false,
      compactType: "vertical",
    })).toBeUndefined();
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

describe("monitorLogic interaction prefs and reset layout", () => {
  it("defaults layoutUnlocked with vertical compact and persists prefs", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    expect(workspace.layoutLocked).toBe(false);
    expect(workspace.compactType).toBe("vertical");
    const persisted = persistMonitorWorkspace(workspace);
    expect(persisted.layoutLocked).toBe(false);
    expect(persisted.compactType).toBe("vertical");

    const locked = setMonitorLayoutLocked(workspace, true);
    expect(locked.layoutLocked).toBe(true);
    expect(setMonitorLayoutLocked(locked, true)).toBe(locked);

    const free = setMonitorCompactType(locked, null);
    expect(free.compactType).toBe(null);
    expect(setMonitorCompactType(free, null)).toBe(free);

    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    saveMonitorWorkspace(free, storage);
    const loaded = loadMonitorWorkspace("/js", storage);
    expect(loaded.layoutLocked).toBe(true);
    expect(loaded.compactType).toBe(null);
  });

  it("hydrates missing prefs from v2 and v1 shapes", () => {
    const v2 = hydrateMonitorWorkspace({
      version: 2,
      selectedDashboardId: "d1",
      dashboards: [{ id: "d1", name: "D", panels: [] }],
    }, "/js");
    expect(v2.layoutLocked).toBe(false);
    expect(v2.compactType).toBe("vertical");

    const v1 = hydrateMonitorWorkspace({
      selectedPanelId: "p1",
      panels: [{ id: "p1", name: "Old", series: [] }],
    }, "/js");
    expect(v1.layoutLocked).toBe(false);
    expect(v1.compactType).toBe("vertical");
  });

  it("repacks dashboard panels into the default 12-col grid", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const dashboardId = workspace.selectedDashboardId;
    const panelId = workspace.dashboards[0]!.panels[0]!.id;
    workspace = updateDashboardLayout(workspace, dashboardId, [
      { i: panelId, x: 9, y: 8, w: 3, h: 4 },
    ]);
    expect(workspace.dashboards[0]!.panels[0]!.layout).toMatchObject({ x: 9, y: 8, w: 3, h: 4 });

    workspace = resetDashboardPanelLayouts(workspace, dashboardId);
    expect(workspace.dashboards[0]!.panels.map((panel) => panel.layout)).toEqual([
      { i: workspace.dashboards[0]!.panels[0]!.id, x: 0, y: 0, w: 4, h: 2 },
      { i: workspace.dashboards[0]!.panels[1]!.id, x: 4, y: 0, w: 4, h: 2 },
      { i: workspace.dashboards[0]!.panels[2]!.id, x: 8, y: 0, w: 4, h: 2 },
      { i: workspace.dashboards[0]!.panels[3]!.id, x: 0, y: 2, w: 4, h: 2 },
      { i: workspace.dashboards[0]!.panels[4]!.id, x: 4, y: 2, w: 4, h: 2 },
      { i: workspace.dashboards[0]!.panels[5]!.id, x: 8, y: 2, w: 4, h: 2 },
      { i: workspace.dashboards[0]!.panels[6]!.id, x: 0, y: 4, w: 4, h: 2 },
    ]);
    expect(workspace.dashboards[0]!.panels[0]!.series.fieldPath).toBe("effort[0]");
  });
});


describe("monitorLogic layout presets", () => {
  it("round-trips extra fields and chart type through a layout preset", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const dashboardId = workspace.selectedDashboardId;
    const panelId = workspace.dashboards[0]!.panels[0]!.id;
    workspace = addSeriesToDashboardPanel(workspace, dashboardId, panelId, createTorqueSeries("/other", 1));
    workspace = updatePanelChart(workspace, dashboardId, panelId, { type: "pie" });
    const preset = createLayoutPresetFromDashboard(workspace.dashboards[0]!, "Mixed")!;
    const imported = hydrateLayoutPresetBundle(JSON.parse(exportLayoutPresetsJson([preset])))[0]!;
    const applied = applyLayoutPresetToDashboard(workspace, dashboardId, imported);
    expect(applied.dashboards[0]!.panels[0]!.additionalSeries[0]!.topic).toBe("/other");
    expect(applied.dashboards[0]!.panels[0]!.chart.type).toBe("pie");
  });

  it("saves and loads named presets from storage", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    const dashboard = workspace.dashboards[0]!;
    const preset = createLayoutPresetFromDashboard(dashboard, "Torque 7", {
      layoutLocked: true,
      compactType: null,
    });
    expect(preset).not.toBeNull();
    expect(preset!.panels).toHaveLength(7);
    expect(preset!.name).toBe("Torque 7");

    const storage = {
      data: new Map<string, string>(),
      getItem(key: string) {
        return this.data.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.data.set(key, value);
      },
    };
    saveLayoutPresets([preset!], storage);
    expect(storage.data.has(MONITOR_LAYOUT_PRESETS_KEY)).toBe(true);
    const loaded = loadLayoutPresets(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe("Torque 7");
    expect(loaded[0]!.layoutLocked).toBe(true);
    expect(loaded[0]!.compactType).toBeNull();
  });

  it("applies a preset onto a dashboard and replaces panels", () => {
    let workspace = createDefaultMonitorWorkspace("/js");
    const empty = createEmptyDashboard("Empty", "dash-empty");
    workspace = addMonitorDashboard(workspace, empty);
    const torque = createDefaultMonitorWorkspace("/js").dashboards[0]!;
    const preset = createLayoutPresetFromDashboard(torque, "From torque")!;
    workspace = applyLayoutPresetToDashboard(workspace, "dash-empty", preset);
    const applied = workspace.dashboards.find((d) => d.id === "dash-empty")!;
    expect(applied.name).toBe("Empty");
    expect(applied.panels).toHaveLength(7);
    expect(applied.panels[0]!.series.fieldPath).toBe("effort[0]");
    expect(applied.panels[0]!.layout).toMatchObject({ x: 0, y: 0, w: 4, h: 2 });
  });

  it("exports and imports JSON without clobbering existing ids", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    const preset = createLayoutPresetFromDashboard(workspace.dashboards[0]!, "A")!;
    const json = exportLayoutPresetsJson([preset]);
    expect(json).toContain('"version": 1');
    expect(hydrateLayoutPresetBundle(JSON.parse(json))).toHaveLength(1);

    const existing = [preset];
    const result = importLayoutPresetsJson(json, existing);
    expect(result.error).toBeUndefined();
    expect(result.imported).toBe(1);
    expect(result.presets).toHaveLength(2);
    expect(result.presets[1]!.id).not.toBe(preset.id);
    expect(result.presets[1]!.name).toBe("A");

    const bad = importLayoutPresetsJson("{not json", existing);
    expect(bad.imported).toBe(0);
    expect(bad.error).toBeTruthy();
  });

  it("upserts and deletes presets", () => {
    const workspace = createDefaultMonitorWorkspace("/js");
    const a = createLayoutPresetFromDashboard(workspace.dashboards[0]!, "A", { id: "layout-a" })!;
    const b = createLayoutPresetFromDashboard(workspace.dashboards[0]!, "B", { id: "layout-b" })!;
    let list = upsertLayoutPreset([], a);
    list = upsertLayoutPreset(list, { ...a, name: "A2" });
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("A2");
    list = upsertLayoutPreset(list, b);
    expect(list).toHaveLength(2);
    list = deleteLayoutPreset(list, "layout-a");
    expect(list.map((p) => p.id)).toEqual(["layout-b"]);
  });
});
