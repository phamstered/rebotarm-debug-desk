import { describe, expect, it } from "vitest";
import {
  HOME_POSITION_ID,
  addPosition,
  captureArmJoints,
  deletePosition,
  emptyPositionStore,
  parsePositionStore,
  profileKeyFor,
  serializePositionStore,
  updatePosition,
} from "./positionLogic";

const profile = { host: "jetson", username: "robot", sshPort: 22 };
const key = profileKeyFor(profile);

describe("position store", () => {
  it("keeps a locked HOME row out of the saved file", () => {
    const store = emptyPositionStore();
    const saved = serializePositionStore(store);
    expect(saved).not.toContain(HOME_POSITION_ID);
    expect(saved).not.toContain("HOME");
    const parsed = parsePositionStore(saved, key);
    expect(parsed.profiles[key]?.positions ?? []).toEqual([]);
    expect(parsed.home.name).toBe("HOME");
    expect(parsed.home.locked).toBe(true);
    expect(parsed.home.sync).toBe("pending");
  });

  it("drops a stored HOME record instead of treating it as a custom point", () => {
    const parsed = parsePositionStore(JSON.stringify({
      schemaVersion: 1,
      profiles: {
        [key]: {
          positions: [{
            id: HOME_POSITION_ID,
            name: "HOME",
            group: "arm",
            jointNames: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
            positions: [1, 1, 1, 1, 1, 1],
            source: "manual",
            note: "",
            capturedAt: null,
            createdAt: 1,
            updatedAt: 1,
          }],
        },
      },
    }), key);
    expect(parsed.profiles[key]?.positions).toEqual([]);
    expect(parsed.home.sync).toBe("pending");
  });

  it("saves, renames and deletes only custom points for one connection", () => {
    let store = emptyPositionStore();
    const created = addPosition(store, key, {
      name: "取料位",
      positions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
      note: "左",
    }, 10, "id-1");
    expect(created.error).toBe("");
    store = created.store;
    expect(store.profiles[key]?.positions[0]?.name).toBe("取料位");

    const renamed = updatePosition(store, key, "id-1", {
      name: "放料位",
      positions: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
      note: "",
    }, 11);
    expect(renamed.error).toBe("");
    store = renamed.store;

    const removed = deletePosition(store, key, "id-1");
    expect(removed.error).toBe("");
    expect(removed.store.profiles[key]?.positions).toEqual([]);

    const blocked = deletePosition(store, key, HOME_POSITION_ID);
    expect(blocked.error).toMatch(/HOME/);
    expect(blocked.store).toBe(store);
  });

  it("rejects reserved names, duplicates and non-finite joints", () => {
    const store = emptyPositionStore();
    expect(addPosition(store, key, { name: "HOME", positions: [0, 0, 0, 0, 0, 0], note: "" }, 1, "a").error).toMatch(/HOME/);
    expect(addPosition(store, key, { name: "  ", positions: [0, 0, 0, 0, 0, 0], note: "" }, 1, "a").error).toMatch(/名称/);
    const first = addPosition(store, key, { name: "取料位", positions: [0, 0, 0, 0, 0, 0], note: "" }, 1, "a");
    expect(addPosition(first.store, key, { name: "取料位", positions: [0, 0, 0, 0, 0, 1], note: "" }, 2, "b").error).toMatch(/名称/);
    expect(addPosition(store, key, { name: "坏点", positions: [0, Number.NaN, 0, 0, 0, 0], note: "" }, 1, "c").error).toMatch(/有限/);
  });

  it("reads six arm joints from a fresh JointState and ignores the gripper", () => {
    const captured = captureArmJoints({
      name: ["joint2", "gripper", "joint1", "joint3", "joint4", "joint5", "joint6"],
      position: [0.2, 9, 0.1, 0.3, 0.4, 0.5, 0.6],
    }, { receivedAt: 1_000, now: 1_200 });
    expect(captured).toEqual({
      positions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    });
    const missing = captureArmJoints(null, { receivedAt: null, now: 1_000 });
    const stale = captureArmJoints({
      name: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"],
      position: [0, 0, 0, 0, 0, 0],
    }, { receivedAt: 1_000, now: 2_500 });
    expect("error" in missing && missing.error).toMatch(/反馈/);
    expect("error" in stale && stale.error).toMatch(/过期/);
  });

  it("does not share points across connection keys", () => {
    const first = addPosition(emptyPositionStore(), key, {
      name: "取料位",
      positions: [0, 0, 0, 0, 0, 0],
      note: "",
    }, 1, "a");
    const other = profileKeyFor({ host: "other", username: "robot", sshPort: 22 });
    expect(first.store.profiles[other]).toBeUndefined();
    expect(parsePositionStore(serializePositionStore(first.store), other).profiles[other]).toBeUndefined();
  });
});
