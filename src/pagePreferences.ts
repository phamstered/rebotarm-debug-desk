import { useEffect } from "react";
import type { AppPage } from "./appNavigationLogic";
import { nativeDesktop } from "./nativeWorkspaceLogic";

/** Preferences have one writer even though every native page mounts App. */
const owners = {
  "robot-console-motion-tab": "motion",
  "robot-console-motion-controllers": "motion",
  "easy-debug-panels": "dashboard",
  "easy-debug-sidebars": "dashboard",
  "easy-debug-layout": "dashboard",
  "robot-console-page": "main",
  "robot-console-nav-expanded": "main",
  "robot-console-workspace-motion-nav": "main",
  "easy-debug-navigate-status-on-connect": "main",
} as const;
export type PagePreferenceKey = keyof typeof owners;
export function ownsPagePreference(key: PagePreferenceKey, page: AppPage | undefined, native = nativeDesktop()) {
  return !native || owners[key] === (page ?? "main");
}
export function usePagePreference(key: PagePreferenceKey, value: string, page?: AppPage) {
  const owner = ownsPagePreference(key, page);
  useEffect(() => {
    if (!owner) return;
    try { localStorage.setItem(key, value); } catch { /* Keep the current in-memory preference. */ }
  }, [key, value, owner]);
}
