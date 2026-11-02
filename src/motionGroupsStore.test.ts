import { expect, it, vi } from "vitest";
const doubles = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
import {
  loadStoredMotionGroups,
  updateStoredMotionGroups,
} from "./motionGroupsStore";
it("preserves errors and never writes after a bad read", async () => {
  doubles.invoke.mockReset().mockResolvedValue("broken");
  await expect(loadStoredMotionGroups()).rejects.toThrow();
  await expect(updateStoredMotionGroups((s) => s)).rejects.toThrow();
  expect(
    doubles.invoke.mock.calls.every(([op]) => op === "motion_groups_load"),
  ).toBe(true);
});
it("serializes read-modify-write transactions without losing different profiles", async () => {
  let raw = '{"schemaVersion":1,"profiles":{}}';
  let active = 0,
    max = 0;
  doubles.invoke
    .mockReset()
    .mockImplementation(async (op: string, args: any) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      if (op === "motion_groups_save") raw = args.content;
      active--;
      return op === "motion_groups_load" ? raw : undefined;
    });
  await Promise.all([
    updateStoredMotionGroups((s) => ({
      ...s,
      profiles: { ...s.profiles, a: { groups: [] } },
    })),
    updateStoredMotionGroups((s) => ({
      ...s,
      profiles: { ...s.profiles, b: { groups: [] } },
    })),
  ]);
  expect(Object.keys(JSON.parse(raw).profiles)).toEqual(["a", "b"]);
  expect(max).toBe(1);
});
