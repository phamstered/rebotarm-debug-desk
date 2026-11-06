import { describe, expect, it } from "vitest";
import { ARM_ERROR_CONTROLLER_TOPIC as JTC, MotionErrorSampler, createMotionErrorDashboard, hasMotionErrorPanels, clearMotionErrorPoints } from "./motionErrorMonitorLogic";
import { createDefaultMonitorWorkspace, addMonitorDashboard, persistMonitorWorkspace, hydrateMonitorWorkspace, panelSeries, updateMonitorFromMessage } from "./monitorLogic";

const JS = "/custom/joints";
const names = Array.from({ length: 6 }, (_, i) => `joint${i + 1}`);
const header = (ms: number) => ({ stamp: { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 } });
const joints = (ms = 1000) => ({ header: header(ms), name: [...names].reverse(), position: [6, 5, 4, 3, 2, 1] });
const controller = (ms = 1010) => ({ header: header(ms), joint_names: names, actual: { positions: [1.01, 2.02, 3.03, 4.04, 5.05, 6.06] }, desired: { positions: [1.11, 2.12, 3.13, 4.14, 5.15, 6.16] } });
const frame = (result: ReturnType<MotionErrorSampler["accept"]>, kind: string) => result?.frames.find(f => f.topic.endsWith(`/${kind}`))?.data;

describe("motion error diagnostics", () => {
  it("compares names, preserves signs and uses same-message desired/actual for tracking", () => {
    const sampler = new MotionErrorSampler();
    expect(sampler.accept("/other", joints(), 0, JS, false)).toBeNull();
    sampler.accept(JS, joints(), 100, JS, false);
    const result = sampler.accept(JTC, controller(), 112, JS, false);
    expect(frame(result, "tracking")?.joint1).toBeCloseTo(.1);
    expect(frame(result, "feedback")?.joint6).toBeCloseTo(.06);
    expect(frame(result, "timing")).toEqual({ header_stamp_ms: 10, receive_time_ms: 12 });
    const newer = joints(1020); newer.position[5] = 1.03;
    const next = sampler.accept(JS, newer, 120, JS, false);
    expect(frame(next, "tracking")).toBeUndefined();
    expect(frame(next, "feedback")?.joint1).toBeCloseTo(-.02);
    expect(frame(next, "timing")?.header_stamp_ms).toBe(-10);
  });

  it("supports modern feedback/reference fields when legacy arrays are empty", () => {
    const sampler = new MotionErrorSampler();
    const c = controller();
    const result = sampler.accept(JTC, { ...c, actual: { positions: [] }, desired: {}, feedback: c.actual, reference: c.desired }, 1, JS, false);
    expect(frame(result, "tracking")?.joint2).toBeCloseTo(.1);
  });

  it("omits absent/non-finite joints instead of plotting zero and invalidates malformed snapshots", () => {
    const sampler = new MotionErrorSampler();
    sampler.accept(JS, joints(), 100, JS, false);
    const c = controller(); c.actual.positions[0] = NaN;
    let result = sampler.accept(JTC, c, 110, JS, false);
    expect(frame(result, "tracking")?.joint1).toBeUndefined();
    expect(frame(result, "feedback")?.joint1).toBeUndefined();
    expect(result?.status.tracking).toContain("joint1");
    result = sampler.accept(JS, { header: header(1020), name: ["joint1"], position: [.5] }, 120, JS, false);
    expect(frame(result, "feedback")).toEqual({});
    result = sampler.accept(JTC, { ...controller(1030), joint_names: ["joint1", "joint1"] }, 130, JS, false);
    expect(frame(result, "tracking")).toEqual({});
    result = sampler.accept(JS, {}, 140, JS, false);
    expect(frame(result, "feedback")).toBeUndefined();
    expect(result?.status.feedback).toContain("时间戳无效");
  });

  it("does not reuse stale feedback or renew its age on duplicate source stamps", () => {
    const sampler = new MotionErrorSampler();
    sampler.accept(JS, joints(), 0, JS, false);
    sampler.accept(JTC, controller(), 10, JS, false);
    expect(sampler.accept(JS, joints(), 999, JS, false)?.frames).toEqual([]);
    const result = sampler.accept(JTC, controller(1020), 1000, JS, false);
    expect(frame(result, "tracking")?.joint1).toBeCloseTo(.1);
    expect(frame(result, "feedback")).toBeUndefined();
    expect(result?.status.stm32At).toBe(0);
    expect(result?.status.feedback).toContain("过期");
  });

  it("exposes large timestamp skew but refuses position pairing and rejects malformed/zero stamps", () => {
    const sampler = new MotionErrorSampler();
    sampler.accept(JS, joints(), 0, JS, false);
    let result = sampler.accept(JTC, controller(2000), 10, JS, false);
    expect(frame(result, "timing")?.header_stamp_ms).toBe(1000);
    expect(frame(result, "feedback")).toBeUndefined();
    for (const h of [header(0), { stamp: { sec: 1, nanosec: 1e9 } }, { stamp: { sec: 1.5, nanosec: 0 } }]) {
      result = sampler.accept(JTC, { ...controller(), header: h }, 20, JS, false);
      expect(frame(result, "tracking")?.joint1).toBeCloseTo(.1);
      expect(frame(result, "feedback")).toBeUndefined();
    }
  });

  it("starts a new epoch on clock rollback, source profile changes and live/bag transitions", () => {
    const sampler = new MotionErrorSampler();
    sampler.accept(JS, joints(), 1, JS, false);
    sampler.accept(JTC, controller(), 2, JS, false);
    let result = sampler.accept(JTC, controller(900), 3, JS, false);
    expect(result?.reset).toBe(true);
    expect(result?.status.stm32At).toBeNull();
    result = sampler.accept(JS, joints(), 4, JS, true);
    expect(result?.reset).toBe(true);
    expect(result?.status.controllerAt).toBeNull();
    result = sampler.accept("/new", joints(), 5, "/new", true);
    expect(result?.reset).toBe(true);
    sampler.reset();
    result = sampler.accept(JTC, controller(), 6, "/new", true);
    expect(frame(result, "feedback")).toBeUndefined();
  });

  it("uses the newer source stamp for paired bag points so cross-topic arrival order cannot reverse time", () => {
    const sampler = new MotionErrorSampler();
    sampler.accept(JTC, controller(1020), 1, JS, true);
    const a = sampler.accept(JS, joints(1000), 2, JS, true);
    const b = sampler.accept(JS, joints(1010), 3, JS, true);
    expect(a?.frames.find(f => f.topic.endsWith("/feedback"))?.sourceTimeMs).toBe(1020);
    expect(b?.frames.find(f => f.topic.endsWith("/feedback"))?.sourceTimeMs).toBe(1020);
  });

  it("persists the template without samples and only clears diagnostic points", () => {
    const dashboard = createMotionErrorDashboard();
    expect(dashboard.panels.map(p => panelSeries(p).length)).toEqual([6, 6, 2]);
    let workspace = addMonitorDashboard(createDefaultMonitorWorkspace(JS), dashboard);
    workspace = updateMonitorFromMessage(workspace, JS, { effort: [2] }, 1);
    workspace = updateMonitorFromMessage(workspace, dashboard.panels[0]!.series.topic, { joint1: .2 }, 1);
    const restored = hydrateMonitorWorkspace(persistMonitorWorkspace(workspace), JS);
    expect(hasMotionErrorPanels(restored.dashboards[1]!)).toBe(true);
    expect(restored.dashboards[1]!.panels[0]!.series.points).toEqual([]);
    const cleared = clearMotionErrorPoints(workspace);
    expect(cleared.dashboards[0]!.panels[0]!.series.points).toHaveLength(1);
    expect(cleared.dashboards[1]!.panels[0]!.series.points).toEqual([]);
    expect(cleared.selectedDashboardId).toBe(dashboard.id);
  });
});
