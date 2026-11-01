import { beforeEach, describe, expect, it } from "vitest";
import { loadAppPage, loadMotionSidebar, loadMotionTab } from "./appNavigationLogic";
const stored = (key: string, value: string | null) => ({ getItem: (requested: string) => requested === key ? value : null });

describe("navigation preferences", () => {
  beforeEach(() => localStorage.clear());
  it.each(["status", "dashboard", "motion", "monitor", "collection", "motor", "calibration", "gravity"] as const)("restores %s without migrating the Topics identifier", (page) => {
    expect(loadAppPage(stored("robot-console-page", page))).toBe(page);
  });
  it.each([null, "", "topics", "robot", "positions", "unknown"])("uses Topics for absent/unknown page %s", (page) => {
    expect(loadAppPage(stored("robot-console-page", page))).toBe("dashboard");
  });
  it("uses independent Motion tab and controller-sidebar preferences", () => {
    localStorage.setItem("robot-console-page", "motion");
    localStorage.setItem("robot-console-motion-tab", "positions");
    localStorage.setItem("robot-console-motion-controllers", "false");
    expect(loadAppPage()).toBe("motion");
    expect(loadMotionTab()).toBe("positions");
    expect(loadMotionSidebar()).toBe(false);
    expect(loadMotionTab(stored("robot-console-motion-tab", "robot"))).toBe("robot");
    expect(loadMotionSidebar(stored("robot-console-motion-controllers", "true"))).toBe(true);
  });
  it.each([null, "", "graph", "unknown"])("defaults invalid Motion preference %s safely", (value) => {
    expect(loadMotionTab(stored("robot-console-motion-tab", value))).toBe("robot");
    expect(loadMotionSidebar(stored("robot-console-motion-controllers", value))).toBe(true);
  });
  it("falls back when reading preferences is unavailable", () => {
    const unavailable = { getItem: () => { throw new Error("Storage blocked"); } };
    expect(loadAppPage(unavailable)).toBe("dashboard");
    expect(loadMotionTab(unavailable)).toBe("robot");
    expect(loadMotionSidebar(unavailable)).toBe(true);
  });
});
