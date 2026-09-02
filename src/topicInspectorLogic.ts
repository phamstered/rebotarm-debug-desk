export function loadJqExpressions(storage: Pick<Storage, "getItem"> = localStorage): Record<string, string> {
  try {
    const saved = storage.getItem("robot-console-jq-filters");
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function validatePublishJson(value: string): string {
  if (!value.trim()) return "请输入 JSON 内容";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "ROS 消息 JSON 顶层必须是对象";
    return "";
  } catch (reason) {
    return `JSON 格式无效：${reason instanceof Error ? reason.message : String(reason)}`;
  }
}
