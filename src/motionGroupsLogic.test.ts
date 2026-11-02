import { expect, it } from "vitest";
import {
  emptyMotionGroupStore,
  groupDeviceReason,
  groupTimeline,
  parseMotionGroupStore,
  serializeMotionGroupStore,
  snapshotStep,
  validateMotionGroup,
  type MotionGroup,
} from "./motionGroupsLogic";
export const group = (): MotionGroup => ({
  id: "g",
  name: "测试",
  note: "备注\n多行",
  preparationDuration: 5,
  createdAt: 1,
  updatedAt: 2,
  steps: [
    {
      id: "s",
      positionId: "p",
      positionName: "P",
      positionUpdatedAt: 1,
      positions: [0, 0, 0, 0, 0, 0],
      duration: 0,
      hold: 2,
    },
    {
      id: "s2",
      positionId: "p2",
      positionName: "P2",
      positionUpdatedAt: 2,
      positions: [1, 0, 0, 0, 0, 0],
      duration: 3,
      hold: 4,
    },
  ],
});
it("uses snapshot arrival/hold timing independently of preparation", () => {
  const g = group();
  expect(
    groupTimeline(g).map(({ start, arrival, departure }) => [
      start,
      arrival,
      departure,
    ]),
  ).toEqual([
    [0, 0, 2],
    [2, 5, 9],
  ]);
  const p = {
    id: "p",
    name: "P",
    updatedAt: 10,
    positions: [1, 2, 3, 4, 5, 6],
    gripperPosition: 0.02,
  } as any;
  const s = snapshotStep(p, "s");
  p.positions[0] = 99;
  expect(s.positions[0]).toBe(1);
  expect(s.duration).toBe(0);
  expect(s.gripperPosition).toBe(0.02);
});
it("rejects corrupt/unknown/duplicate/unsafe files rather than silently emptying", () => {
  const store = emptyMotionGroupStore();
  store.profiles.p = { groups: [group()] };
  expect(parseMotionGroupStore(serializeMotionGroupStore(store))).toEqual(
    store,
  );
  for (const text of [
    "",
    "broken",
    '{"schemaVersion":2,"profiles":{}}',
    '{"schemaVersion":1,"profiles":{"__proto__":{"groups":[]}}}',
  ])
    expect(() => parseMotionGroupStore(text)).toThrow();
  store.profiles.p.groups.push(group());
  expect(() => serializeMotionGroupStore(store)).toThrow(/重复/);
});
it("validates timing, finite joints, gripper, IDs and aggregate boundaries", () => {
  for (const mutate of [
    (g: MotionGroup) => (g.steps[0].duration = 1),
    (g) => (g.steps[1].duration = 0),
    (g) => (g.steps[0].hold = -1),
    (g) => (g.steps[0].positions[2] = NaN),
    (g) => (g.steps[0].gripperPosition = Infinity),
    (g) => (g.steps[1].id = g.steps[0].id),
    (g) => (g.preparationDuration = 604801),
    (g) =>
      (g.steps = Array.from({ length: 101 }, (_, i) => ({
        ...g.steps[0],
        id: String(i),
      }))),
    (g) => (g.id = "中".repeat(43)),
  ] as ((g: MotionGroup) => unknown)[]) {
    const g = group();
    mutate(g);
    expect(validateMotionGroup(g)).not.toBe("");
  }
  expect(validateMotionGroup(group())).toBe("");
});

it("validates and round-trips Pose tracks and camera Action dependencies", () => {
  const g = group();
  g.tracks = [{ id: "arm", kind: "arm", name: "机械臂", deviceId: "current" }, { id: "camera", kind: "camera", name: "相机", deviceId: "current" }];
  g.actions = [{ id: "photo", type: "camera_capture", name: "拍照", trackId: "camera", afterStepId: "s", topic: "/test/image", timeout: 5 }];
  expect(validateMotionGroup(g)).toBe(""); expect(groupDeviceReason(g)).toBe("");
  const store = { schemaVersion: 1 as const, profiles: { p: { groups: [g] } } };
  expect(parseMotionGroupStore(serializeMotionGroupStore(store))).toEqual(store);
  expect(groupTimeline(g)[1].start).toBe(7);
  for (const changes of [{ topic: "/bad//path" }, { topic: "/a/../image" }, { timeout: 0 }, { timeout: Infinity }, { afterStepId: "deleted" }, { trackId: "arm" }, { type: "shell" }, { id: "s2" }]) {
    const bad = structuredClone(g); Object.assign(bad.actions![0], changes); expect(validateMotionGroup(bad)).not.toBe("");
  }
  const remote = structuredClone(g); remote.tracks![1].deviceId = "other-robot";
  expect(groupDeviceReason(remote)).toContain("当前 Bridge");
  g.tracks.push({ id: "arm2", name: "机械臂 B", kind: "arm", deviceId: "robot-b" });
  expect(validateMotionGroup(g)).toBe(""); expect(groupDeviceReason(g)).toContain("多臂");
});
