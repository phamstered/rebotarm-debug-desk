import { expect, it } from "vitest";
import { decodeMotionGroupStore, assertMotionGroupUnchanged } from "./motionGroupsStore";
import { decodePositionStore, assertPositionUnchanged } from "./positionStore";
it("preserves invalid documents instead of silently replacing them with empty data", () => {
  for (const raw of ["broken", "null", "{}", '{"schemaVersion":9,"profiles":{}}']) {
    expect(() => decodeMotionGroupStore(raw)).toThrow(); expect(() => decodePositionStore(raw)).toThrow();
  }
  expect(() => decodePositionStore('{"schemaVersion":2,"profiles":{"p":{"positions":[{}]}}}')).toThrow(/无效记录/);
  expect(decodeMotionGroupStore(null).profiles).toEqual({}); expect(decodePositionStore(null).profiles).toEqual({});
});
it("accepts absent records only for creation and refuses resurrecting deleted drafts", () => {
  expect(() => assertMotionGroupUnchanged(undefined, "")).not.toThrow();
  expect(() => assertMotionGroupUnchanged(undefined, "old")).toThrow(/删除/);
  expect(() => assertPositionUnchanged(undefined, "old")).toThrow(/删除/);
});
