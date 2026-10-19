import { describe, expect, it } from "vitest";
import { collectionActions, collectionConfigError, defaultCollectionConfig, loadCollectionConfig, validCollectionPath, type CollectionStatus } from "./dataCollectionLogic";

const good = { ...defaultCollectionConfig, repoId: "robot/demo", task: "抓起红色方块" };
const idle: CollectionStatus = { state: "idle", managed: true, pid: 42, recording: false, pendingFrames: 0, savedEpisodes: 2, fps: 20, task: good.task, repoId: good.repoId, root: good.root, message: "", log: "" };

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
    expect(collectionActions({ ...idle, pendingFrames: 20 }, true, true).finish).toBe(false);
    expect(collectionActions({ ...idle, state: "recording", recording: true }, true, true)).toMatchObject({ start: false, save: false, discard: true, finish: false });
    expect(collectionActions({ ...idle, managed: false }, true, true).finish).toBe(false);
    expect(collectionActions(idle, true, true).finish).toBe(true);
    expect(collectionActions({ ...idle, state: "finalizing" }, true, true)).toMatchObject({ launch: false, start: false, save: false, discard: false, finish: false });
  });
});
