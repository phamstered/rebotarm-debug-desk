export function loadJqExpressions(storage: Pick<Storage, "getItem"> = localStorage): Record<string, string> {
  try {
    const saved = storage.getItem("robot-console-jq-filters");
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
