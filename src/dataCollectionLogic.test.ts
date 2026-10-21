import { describe, expect, it } from "vitest";
import {
  collectionActions,
  collectionArmReady,
  collectionConfigError,
  collectionRecordingHazardReason,
  collectionStampOk,
  collectionStartBlockedReason,
  defaultCollectionConfig,
  loadCollectionConfig,
  validCollectionPath,
  type CollectionStatus,
} from "./dataCollectionLogic";
import type { HardwareStatus } from "./types";

const good = { ...defaultCollectionConfig, repoId: "robot/demo", task: "抓起红色方块" };
const idle: CollectionStatus = { state: "idle", managed: true, pid: 42, recording: false, pendingFrames: 0, savedEpisodes: 2, fps: 20, task: good.task, repoId: good.repoId, root: good.root, message: "", log: "" };
const trackOk: HardwareStatus = { mode: 1, mode_name: "TRACK", fault_code: 0, last_command_sequence: 9 };
const hold: HardwareStatus = { mode: 0, mode_name: "HOLD", fault_code: 0 };
const fault11: HardwareStatus = { mode: 1, mode_name: "TRACK", fault_code: 11 };
const freshStamp = (now = 10_000) => ({
  data: { header: { stamp: { sec: 1_700_000_000, nanosec: 123 }, frame_id: "" }, name: ["j1"], position: [0] },
  lastAt: now,
});

describe("data collection config", () => {
  it("accepts recorder defaults with a task and ID, preserving Unicode task text", () => {
    expect(collectionConfigError(good)).toBe("");
    expect(collectionConfigError({ ...good, task: "抓 'cube' $(echo literal)\n放下" })).toBe("");
    for (const root of ["/data/demo", "lerobot_datasets/demo"]) expect(validCollectionPath(root)).toBe(true);
  });
  it("rejects paths, topics and invalid dataset inputs before launching", () => {
    for (const root of ["../data", "~/data", "/a//b", "-data", "data;rm", ""]) expect(collectionConfigError({ ...good, root })).not.toBe("");
    for (const wristImageTopic of ["/a//b", "/", "relative", "/1bad", "/a;bad"]) expect(collectionConfigError({ ...good, wristImageTopic })).not.toBe("");
    for (const fps of [0, -1, 1.5, NaN, Infinity, 121]) expect(collectionConfigError({ ...good, fps })).not.toBe("");
    expect(collectionConfigError({ ...good, repoId: "no_namespace" })).not.toBe("");
    expect(collectionConfigError({ ...good, task: "\0" })).not.toBe("");
    expect(collectionConfigError({ ...good, task: " " })).not.toBe("");
  });
  it("restores supported preferences without accepting wrong types", () => {
    expect(loadCollectionConfig({ getItem: () => "broken" })).toEqual(defaultCollectionConfig);
    expect(loadCollectionConfig({ getItem: () => JSON.stringify({ fps: "bad", repoId: "robot/demo", resume: true, unknown: "value" }) })).toEqual({ ...defaultCollectionConfig, repoId: "robot/demo", resume: true });
  });
});

describe("episode availability", () => {
  it("requires fresh status and ROS feedback, and never finishes pending work", () => {
    expect(collectionActions(idle, false, true).start).toBe(false);
    expect(collectionActions(idle, true, false).start).toBe(false);
    expect(collectionActions(idle, true, true).start).toBe(true);
    expect(collectionActions(idle, true, true, false, true).start).toBe(false);
    expect(collectionActions(idle, true, true, true, false).start).toBe(false);
    expect(collectionActions({ ...idle, pendingFrames: 20 }, true, true).finish).toBe(false);
    expect(collectionActions({ ...idle, state: "recording", recording: true }, true, true)).toMatchObject({ start: false, save: false, discard: true, finish: false });
    expect(collectionActions({ ...idle, managed: false }, true, true).finish).toBe(false);
    expect(collectionActions(idle, true, true).finish).toBe(true);
    expect(collectionActions({ ...idle, state: "finalizing" }, true, true)).toMatchObject({ launch: false, start: false, save: false, discard: false, finish: false });
  });
  it("disables launch when fault_code is 11; start blocked via armReady", () => {
    expect(collectionActions(idle, true, true, false, true, 11).start).toBe(false);
    expect(collectionActions({ ...idle, state: "stopped" }, true, true, true, true, 11).launch).toBe(false);
    expect(collectionActions(idle, true, true, true, true, 0).start).toBe(true);
  });
});

describe("collection arm and stamp preflight", () => {
  it("allows TRACK with fault 0 and a non-zero fresh stamp", () => {
    expect(collectionArmReady(trackOk)).toBe(true);
    expect(collectionStampOk(freshStamp(10_000), 10_100)).toBe(true);
    expect(collectionStartBlockedReason({
      hardwareStatus: trackOk,
      jointStateSample: freshStamp(10_000),
      rosReady: true,
      nowMs: 10_100,
    })).toBe("");
  });

  it("blocks HOLD, fault 11, missing status, and unknown fault", () => {
    expect(collectionArmReady(hold)).toBe(false);
    expect(collectionArmReady(fault11)).toBe(false);
    expect(collectionArmReady(null)).toBe(false);
    expect(collectionArmReady({ mode: 1, mode_name: "TRACK" })).toBe(false);
    expect(collectionStartBlockedReason({ hardwareStatus: hold, jointStateSample: freshStamp(), rosReady: true, nowMs: 10_000 })).toMatch(/HOLD/);
    expect(collectionStartBlockedReason({ hardwareStatus: fault11, jointStateSample: freshStamp(), rosReady: true, nowMs: 10_000 })).toMatch(/故障码 11/);
    expect(collectionStartBlockedReason({ hardwareStatus: null, jointStateSample: freshStamp(), rosReady: true, nowMs: 10_000 })).toMatch(/stm32\/status/);
  });

  it("blocks all-zero or stale joint stamps", () => {
    const zero = { data: { header: { stamp: { sec: 0, nanosec: 0 } } }, lastAt: 10_000 };
    const stale = freshStamp(1_000);
    expect(collectionStampOk(zero, 10_100)).toBe(false);
    expect(collectionStampOk(stale, 5_000)).toBe(false);
    expect(collectionStartBlockedReason({
      hardwareStatus: trackOk, jointStateSample: zero, rosReady: true, nowMs: 10_100,
    })).toMatch(/全 0/);
    expect(collectionStartBlockedReason({
      hardwareStatus: trackOk, jointStateSample: stale, rosReady: true, nowMs: 5_000,
    })).toMatch(/过期/);
  });

  it("recommends discard when fault appears or mode leaves TRACK mid-recording", () => {
    expect(collectionRecordingHazardReason(trackOk)).toBe("");
    expect(collectionRecordingHazardReason(fault11)).toMatch(/故障码 11/);
    expect(collectionRecordingHazardReason(hold)).toMatch(/离开 TRACK/);
    expect(collectionRecordingHazardReason(null)).toMatch(/未收到/);
  });
});
