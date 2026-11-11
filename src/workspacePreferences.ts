import { useEffect, useState } from "react";
export function readWorkspacePreference<T extends string | boolean>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): T {
  try {
    const value = JSON.parse(
      localStorage.getItem(`robot-console-workspace-${key}`) ?? "null",
    );
    return typeof value === typeof fallback &&
      (!allowed || allowed.includes(value))
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}
export function useWorkspacePreference<T extends string | boolean>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
  persist = true,
) {
  const [value, setValue] = useState<T>(() =>
    readWorkspacePreference(key, fallback, allowed),
  );
  useEffect(() => {
    if (!persist) return;
    try {
      localStorage.setItem(
        `robot-console-workspace-${key}`,
        JSON.stringify(value),
      );
    } catch {
      /* Retain preference in memory. */
    }
  }, [key, value, persist]);
  return [value, setValue] as const;
}
