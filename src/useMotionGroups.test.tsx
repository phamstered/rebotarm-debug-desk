import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const doubles = vi.hoisted(() => ({ invoke: vi.fn(), handlers: new Set<(event: any) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_: string, handler: (event: any) => void) => { doubles.handlers.add(handler); return () => doubles.handlers.delete(handler); }) }));
import { useMotionGroups } from "./useMotionGroups";
import { usePositions } from "./usePositions";
import { positionFingerprint } from "./positionStore";
import type { MotionGroup } from "./motionGroupsLogic";
import type { EditorDocumentSnapshot } from "./editorDocumentLogic";
const g: MotionGroup = {
  id: "g", name: "组", note: "", preparationDuration: 5, createdAt: 0, updatedAt: 0,
  steps: [{ id: "s", positionId: "p", positionName: "P", positionUpdatedAt: 0, positions: [0, 0, 0, 0, 0, 0], duration: 0, hold: 0 }],
};
const draft = {name: "姿态", positions: [0, 0, 0, 0, 0, 0], note: ""};
let documents: Map<string, EditorDocumentSnapshot>;
function snapshot(key: string) { return documents.get(key) ?? {revision: 0, content: null}; }
function notify(key: string) { doubles.handlers.forEach(fn => fn({payload: {key, revision: snapshot(key).revision}})); }
beforeEach(() => {
  documents = new Map(); doubles.handlers.clear();
  doubles.invoke.mockReset().mockImplementation(async (command: string, args: any) => {
    if (command === "editor_document_read") return {...snapshot(args.key)};
    if (command === "editor_document_commit") {
      const before = snapshot(args.key);
      if (args.expected !== before.revision) return {accepted: false, snapshot: {...before}};
      const next = {revision: before.revision + 1, content: args.content}; documents.set(args.key, next); notify(args.key);
      return {accepted: true, snapshot: {...next}};
    }
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(() => {cleanup(); doubles.handlers.clear();});
it("keeps read failure and refuses saves without overwriting the bad file", async () => {
  documents.set("motion_groups", {revision: 1, content: "坏文件"});
  const h = renderHook(() => useMotionGroups("p"));
  await waitFor(() => expect(h.result.current.error).not.toBe(""));
  expect(h.result.current.ready).toBe(false);
  await expect(h.result.current.saveGroup(g, "")).rejects.toThrow(/尚未/);
  expect(doubles.invoke.mock.calls.every(([op]) => op === "editor_document_read")).toBe(true);
  expect(snapshot("motion_groups").content).toBe("坏文件");
});
it("ignores stale document replies and shows only the selected profile", async () => {
  let first!: (x: any) => void;
  doubles.invoke.mockImplementationOnce(() => new Promise(r => {first = r;}));
  const h = renderHook(({p}) => useMotionGroups(p), {initialProps: {p: "a"}});
  await waitFor(() => expect(first).toBeDefined());
  h.rerender({p: "b"});
  documents.set("motion_groups", {revision: 2, content: JSON.stringify({schemaVersion: 1, profiles: {b: {groups: [g]}}})});
  await act(async () => { notify("motion_groups"); first({revision: 1, content: '{"schemaVersion":1,"profiles":{"a":{"groups":[]}}}'}); });
  await waitFor(() => expect(h.result.current.groups).toEqual([g]));
  h.rerender({p: "a"}); expect(h.result.current.groups).toEqual([]);
});
it("guards concurrent writes and isolates completed old saves from a new profile", async () => {
  const base = doubles.invoke.getMockImplementation()!;
  let finish!: () => void;
  doubles.invoke.mockImplementation((op, args) => op === "editor_document_commit" ? new Promise(resolve => {finish = () => resolve(base(op, args));}) : base(op, args));
  const h = renderHook(({p}) => useMotionGroups(p), {initialProps: {p: "a"}});
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  const old = h.result.current;
  let save!: Promise<void>;
  act(() => {save = old.saveGroup(g, "");});
  await waitFor(() => expect(finish).toBeDefined());
  expect(h.result.current.saving).toBe(true);
  await expect(h.result.current.deleteGroup("g", "")).rejects.toThrow(/正在/);
  h.rerender({p: "b"});
  await expect(old.saveGroup(g, "")).rejects.toThrow(/切换/);
  await act(async () => {finish(); await save;});
  expect(h.result.current.groups).toEqual([]); expect(h.result.current.saving).toBe(false);
  expect(JSON.parse(snapshot("motion_groups").content!).profiles.a.groups).toEqual([g]);
});
it("retains persisted groups after disk failure and supports explicit retry", async () => {
  const h = renderHook(() => useMotionGroups("a"));
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  const base = doubles.invoke.getMockImplementation()!;
  doubles.invoke.mockImplementation((op, args) => op === "editor_document_commit" ? Promise.reject(new Error("磁盘满")) : base(op, args));
  await act(async () => {await expect(h.result.current.saveGroup(g, "")).rejects.toThrow("磁盘满");});
  expect(h.result.current.groups).toEqual([]); expect(h.result.current.saving).toBe(false); expect(snapshot("motion_groups").revision).toBe(0);
  doubles.invoke.mockImplementation(base);
  await act(async () => {await h.result.current.saveGroup(g, "");});
  expect(h.result.current.groups).toEqual([g]); expect(h.result.current.error).toBe("");
});
it("shares group changes and rejects stale same-record edits and deletions", async () => {
  const a = renderHook(() => useMotionGroups("p")), b = renderHook(() => useMotionGroups("p")), other = renderHook(() => useMotionGroups("other"));
  await waitFor(() => expect(a.result.current.ready && b.result.current.ready && other.result.current.ready).toBe(true));
  await act(async () => {await a.result.current.saveGroup(g, "");});
  await waitFor(() => expect(b.result.current.groups).toEqual([g]));
  const baseline = JSON.stringify(g);
  await act(async () => {await b.result.current.saveGroup({...g, name: "新的"}, baseline); await other.result.current.saveGroup(g, "");});
  await act(async () => {await expect(a.result.current.saveGroup({...g, name: "旧草稿"}, baseline)).rejects.toThrow(/其他窗口/); await expect(a.result.current.deleteGroup(g.id, baseline)).rejects.toThrow(/其他窗口/);});
  expect(a.result.current.groups[0].name).toBe("新的");
  expect(Object.keys(JSON.parse(snapshot("motion_groups").content!).profiles)).toEqual(["p", "other"]);
});
it("shares positions from Status with Motion, preserves other profiles, and refuses stale deletion", async () => {
  const status = renderHook(() => usePositions("p")), motion = renderHook(() => usePositions("p")), other = renderHook(() => usePositions("other"));
  await waitFor(() => expect(status.result.current.ready && motion.result.current.ready && other.result.current.ready).toBe(true));
  await act(async () => {expect(await status.result.current.create(draft)).toBe("");});
  await waitFor(() => expect(motion.result.current.store.profiles.p.positions).toHaveLength(1));
  const point = motion.result.current.store.profiles.p.positions[0], baseline = positionFingerprint(point);
  await act(async () => {expect(await motion.result.current.update(point.id, {...draft, name: "新名字"}, baseline)).toBe(""); expect(await other.result.current.create(draft)).toBe("");});
  await act(async () => {expect(await status.result.current.remove(point.id, baseline)).toContain("其他窗口"); expect(await status.result.current.update(point.id, draft, baseline)).toContain("其他窗口");});
  const saved = JSON.parse(snapshot("positions").content!);
  expect(saved.profiles.p.positions[0].name).toBe("新名字"); expect(saved.profiles.other.positions).toHaveLength(1);
});
it("never saves after an invalid position read or from a disabled reader", async () => {
  documents.set("positions", {revision: 1, content: '{"schemaVersion":2,"profiles":{"p":{"positions":[{}]}}}'});
  const h = renderHook(() => usePositions("p")), inactive = renderHook(() => usePositions("p", false));
  await waitFor(() => expect(h.result.current.error).not.toBe(""));
  expect(await h.result.current.create(draft)).toContain("尚未"); expect(await inactive.result.current.create(draft)).toContain("尚未");
  expect(doubles.invoke.mock.calls.every(([op]) => op === "editor_document_read")).toBe(true);
});
