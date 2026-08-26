import { describe, expect, it } from "vitest";
import { loadJqExpressions } from "./topicInspectorLogic";

describe("Topic Inspector persistence", () => {
  it("restores jq expressions and falls back after malformed persistence", () => {
    expect(loadJqExpressions({ getItem: () => '{"/joint_states":".position[0]"}' }))
      .toEqual({ "/joint_states": ".position[0]" });
    expect(loadJqExpressions({ getItem: () => "{" })).toEqual({});
  });
});
