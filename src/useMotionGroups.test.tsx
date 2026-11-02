import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const doubles = vi.hoisted(() => ({ load: vi.fn(), update: vi.fn() }));
vi.mock("./motionGroupsStore", () => ({
  loadStoredMotionGroups: doubles.load,
  updateStoredMotionGroups: doubles.update,
}));
import { useMotionGroups } from "./useMotionGroups";
import type { MotionGroup } from "./motionGroupsLogic";
const g: MotionGroup = {
  id: "g",
  name: "组",
  note: "",
  preparationDuration: 5,
  createdAt: 0,
  updatedAt: 0,
  steps: [
    {
      id: "s",
      positionId: "p",
      positionName: "P",
      positionUpdatedAt: 0,
      positions: [0, 0, 0, 0, 0, 0],
      duration: 0,
      hold: 0,
    },
  ],
};
it("keeps read failure and refuses saves", async () => {
  doubles.load.mockReset().mockRejectedValue(new Error("坏文件"));
  doubles.update.mockReset();
  const h = renderHook(() => useMotionGroups("p"));
  await waitFor(() => expect(h.result.current.error).toContain("坏文件"));
  expect(h.result.current.ready).toBe(false);
  await expect(h.result.current.saveGroup(g)).rejects.toThrow(/尚未/);
  expect(doubles.update).not.toHaveBeenCalled();
});
it("ignores a stale profile load and hides the previous profile synchronously", async () => {
  let first!: (x: any) => void;
  doubles.load
    .mockReset()
    .mockImplementationOnce(() => new Promise((r) => (first = r)))
    .mockResolvedValue({ schemaVersion: 1, profiles: { b: { groups: [g] } } });
  const h = renderHook(({ p }) => useMotionGroups(p), {
    initialProps: { p: "a" },
  });
  h.rerender({ p: "b" });
  await waitFor(() => expect(h.result.current.groups).toEqual([g]));
  await act(async () =>
    first({ schemaVersion: 1, profiles: { a: { groups: [] } } }),
  );
  expect(h.result.current.groups).toEqual([g]);
});
it("guards concurrent writes and prevents a completed old save contaminating a new profile", async () => {
  let finish!: (x: any) => void;
  doubles.load
    .mockReset()
    .mockResolvedValue({ schemaVersion: 1, profiles: {} });
  doubles.update
    .mockReset()
    .mockImplementation(() => new Promise((r) => (finish = r)));
  const h = renderHook(({ p }) => useMotionGroups(p), {
    initialProps: { p: "a" },
  });
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  let save!: Promise<void>;
  act(() => {
    save = h.result.current.saveGroup(g);
  });
  await expect(h.result.current.deleteGroup("g")).rejects.toThrow(/正在/);
  h.rerender({ p: "b" });
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => {
    finish({ schemaVersion: 1, profiles: { a: { groups: [g] } } });
    await save;
  });
  expect(h.result.current.groups).toEqual([]);
  expect(h.result.current.saving).toBe(false);
});
it("retains the last persisted groups on write failure and supports an explicit retry", async () => {
  doubles.load
    .mockReset()
    .mockResolvedValue({ schemaVersion: 1, profiles: { a: { groups: [] } } });
  doubles.update
    .mockReset()
    .mockRejectedValueOnce(new Error("磁盘满"))
    .mockResolvedValueOnce({
      schemaVersion: 1,
      profiles: { a: { groups: [g] } },
    });
  const h = renderHook(() => useMotionGroups("a"));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(async () => {
    await expect(h.result.current.saveGroup(g)).rejects.toThrow("磁盘满");
  });
  expect(h.result.current.error).toContain("磁盘满");
  expect(h.result.current.groups).toEqual([]);
  expect(h.result.current.saving).toBe(false);
  await act(async () => h.result.current.saveGroup(g));
  expect(h.result.current.groups).toEqual([g]);
  expect(h.result.current.error).toBe("");
});
