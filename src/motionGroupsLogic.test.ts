import { expect, it } from "vitest";
import {
  emptyMotionGroupStore,
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
