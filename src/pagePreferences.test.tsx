import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { APP_PAGES } from "./appNavigationLogic";
import { ownsPagePreference, usePagePreference, type PagePreferenceKey } from "./pagePreferences";
import { useWorkspacePreference } from "./workspacePreferences";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});
it("assigns each App preference to exactly one native writer and retains browser behavior", () => {
  const expected = {
    "robot-console-motion-tab": "motion", "robot-console-motion-controllers": "motion",
    "easy-debug-panels": "dashboard", "easy-debug-sidebars": "dashboard", "easy-debug-layout": "dashboard",
    "robot-console-page": undefined, "robot-console-nav-expanded": undefined,
    "robot-console-workspace-motion-nav": undefined, "easy-debug-navigate-status-on-connect": undefined,
  } as const;
  for (const key of Object.keys(expected) as PagePreferenceKey[]) {
    expect([undefined, ...APP_PAGES].filter(page => ownsPagePreference(key, page))).toEqual([expected[key]]);
    for (const page of [undefined, ...APP_PAGES]) expect(ownsPagePreference(key, page, false)).toBe(true);
  }
});
it("a stale reader cannot overwrite a preference after its owner changes it", () => {
  const reader = renderHook(({ value }) => usePagePreference("robot-console-motion-tab", value, "handeye"), { initialProps: {value: "robot"} });
  const writer = renderHook(({ value }) => usePagePreference("robot-console-motion-tab", value, "motion"), { initialProps: {value: "groups"} });
  reader.rerender({value: "positions"});
  expect(localStorage.getItem("robot-console-motion-tab")).toBe("groups");
  writer.rerender({value: "urdf"});
  reader.unmount();
  const reopened = renderHook(() => usePagePreference("robot-console-motion-tab", "robot", "monitor"));
  expect(localStorage.getItem("robot-console-motion-tab")).toBe("urdf");
  reopened.unmount(); writer.unmount();
});
it("keeps in-memory layout usable when storage fails", () => {
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw Error("quota"); });
  expect(() => renderHook(() => usePagePreference("easy-debug-layout", "{}", "dashboard"))).not.toThrow();
});
it("non-owning workspace preferences never save initial or changed state", () => {
  localStorage.setItem("robot-console-workspace-motion-nav", "true");
  const reader = renderHook(() => useWorkspacePreference("motion-nav", false, undefined, false));
  act(() => reader.result.current[1](false));
  expect(reader.result.current[0]).toBe(false);
  expect(localStorage.getItem("robot-console-workspace-motion-nav")).toBe("true");
  reader.unmount();
});
