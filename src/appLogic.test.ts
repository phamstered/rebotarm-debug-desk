import { describe, expect, it } from "vitest";
import { checkBridgeVersion, defaultPanelState, defaultSidebarState, formatBridgeVersionLabel, loadPanelState, loadProfile, loadSidebarState, migrateProfile, nextTopicSample } from "./appLogic";
import { defaultProfile } from "./types";

const storage = (value: string | null) => ({ getItem: () => value });

describe("connection profile", () => {
  it("uses defaults when there is no saved profile or malformed JSON", () => {
    expect(loadProfile(storage(null))).toEqual(defaultProfile);
    expect(loadProfile(storage("{"))).toEqual(defaultProfile);
  });

  it("migrates legacy ROS setup and joint-state topic values", () => {
    const profile = migrateProfile({
      host: "robot",
      rosSetupScript: "/home/jialiang/Project/install/setup.bash",
      jointStateTopic: "/joint_states",
    });
    expect(profile.host).toBe("robot");
    expect(profile.rosSetupScript).toBe(defaultProfile.rosSetupScript);
    expect(profile.jointStateTopic).toBe("/stm32/joint_states");
  });
});

describe("panel and topic state", () => {
  it("loads defaults and merges persisted collapsed panels", () => {
    expect(loadPanelState(storage(null))).toEqual(defaultPanelState);
    expect(loadPanelState(storage('{"topics":false}'))).toEqual({ topics: false, rosControl: true, inspector: true });
    expect(loadPanelState(storage('{"motor":false,"inspector":false}'))).toEqual({ topics: true, rosControl: true, inspector: false });
    expect(loadPanelState(storage("bad"))).toEqual(defaultPanelState);
  });

  it("loads persistent outer sidebar visibility", () => {
    expect(loadSidebarState(storage(null))).toEqual(defaultSidebarState);
    expect(loadSidebarState(storage('{"left":false}'))).toEqual({ left: false, right: true });
    expect(loadSidebarState(storage("bad"))).toEqual(defaultSidebarState);
  });

  it("counts messages and calculates average frequency", () => {
    const first = nextTopicSample(undefined, { value: 1 }, 1000);
    const second = nextTopicSample(first, { value: 2 }, 1500);
    expect(first).toMatchObject({ count: 1, hz: 0, firstAt: 1000, lastAt: 1000 });
    expect(second).toMatchObject({ data: { value: 2 }, count: 2, hz: 2, firstAt: 1000, lastAt: 1500 });
  });
});


describe("bridge version check", () => {
  const expected = { version: "0.1.0", buildId: "abc1234def56" };

  it("matches identical version and build id", () => {
    expect(
      checkBridgeVersion(
        { bridge_version: "0.1.0", bridge_build_id: "abc1234def56", ros_distro: "humble" },
        expected,
      ),
    ).toMatchObject({ status: "match" });
  });

  it("reports mismatch when build id differs", () => {
    const result = checkBridgeVersion(
      { bridge_version: "0.1.0", bridge_build_id: "ffffffffffffffff", ros_distro: "humble" },
      expected,
    );
    expect(result.status).toBe("mismatch");
    if (result.status === "mismatch") {
      expect(formatBridgeVersionLabel(result.remote)).toContain("ffffffffffffffff");
      expect(formatBridgeVersionLabel(result.local)).toContain("abc1234def56");
    }
  });

  it("warns without forcing upgrade when build id is missing", () => {
    const result = checkBridgeVersion({ bridge_version: "0.1.0", ros_distro: "humble" }, expected);
    expect(result).toMatchObject({ status: "unknown", reason: "missing_build_id", message: "无法确认版本" });
  });
});
