import { describe, expect, it } from "vitest";
import { defaultPanelState, loadPanelState, loadProfile, migrateProfile, nextTopicSample } from "./appLogic";
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
    expect(loadPanelState(storage('{"topics":false}'))).toEqual({ topics: false, motor: true, inspector: true });
    expect(loadPanelState(storage("bad"))).toEqual(defaultPanelState);
  });

  it("counts messages and calculates average frequency", () => {
    const first = nextTopicSample(undefined, { value: 1 }, 1000);
    const second = nextTopicSample(first, { value: 2 }, 1500);
    expect(first).toMatchObject({ count: 1, hz: 0, firstAt: 1000, lastAt: 1000 });
    expect(second).toMatchObject({ data: { value: 2 }, count: 2, hz: 2, firstAt: 1000, lastAt: 1500 });
  });
});
