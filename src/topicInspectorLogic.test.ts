import { describe, expect, it } from "vitest";
import { loadJqExpressions, validatePublishJson } from "./topicInspectorLogic";

describe("Topic Inspector persistence", () => {
  it("restores jq expressions and falls back after malformed persistence", () => {
    expect(loadJqExpressions({ getItem: () => '{"/joint_states":".position[0]"}' }))
      .toEqual({ "/joint_states": ".position[0]" });
    expect(loadJqExpressions({ getItem: () => "{" })).toEqual({});
  });

  it("validates publish JSON as a ROS message object", () => {
    expect(validatePublishJson("")).toBe("请输入 JSON 内容");
    expect(validatePublishJson("{")).toContain("JSON 格式无效");
    expect(validatePublishJson("[1,2]")).toBe("ROS 消息 JSON 顶层必须是对象");
    expect(validatePublishJson('{"data":1}')).toBe("");
  });
});
