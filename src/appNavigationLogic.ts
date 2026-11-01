const APP_PAGES = ["status", "dashboard", "motion", "monitor", "collection", "motor", "calibration", "gravity"] as const;
export type AppPage = typeof APP_PAGES[number];
export type MotionTab = "robot" | "positions";
type NavigationStorage = Pick<Storage, "getItem">;

function readPreference(storage: NavigationStorage, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}

/** `dashboard` remains the stored Topics page identifier for existing installs. */
export function loadAppPage(storage: NavigationStorage = localStorage): AppPage {
  const saved = readPreference(storage, "robot-console-page");
  return APP_PAGES.some((page) => page === saved) ? saved as AppPage : "dashboard";
}

export function loadMotionTab(storage: NavigationStorage = localStorage): MotionTab {
  return readPreference(storage, "robot-console-motion-tab") === "positions" ? "positions" : "robot";
}

export function loadMotionSidebar(storage: NavigationStorage = localStorage): boolean {
  return readPreference(storage, "robot-console-motion-controllers") !== "false";
}
