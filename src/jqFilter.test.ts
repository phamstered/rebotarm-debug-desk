import { describe, expect, it } from "vitest";
import { formatJqOutputs, runJqFilter } from "./jqFilter";

describe("jq topic filtering", () => {
  it("runs real jq expressions against ROS JSON messages", async () => {
    await expect(runJqFilter({ position: [0.1, 0.6], name: ["a", "b"] }, ".position[1]")).resolves.toEqual([0.6]);
    await expect(runJqFilter({ values: [1, 2, 3] }, ".values[] | select(. > 1)")).resolves.toEqual([2, 3]);
  });

  it("formats zero, single and multiple jq outputs", () => {
    expect(formatJqOutputs([])).toBe("（jq 没有输出）");
    expect(formatJqOutputs([2])).toBe("2");
    expect(formatJqOutputs([2, 3])).toBe("[\n  2,\n  3\n]");
  });
});
