import { describe, expect, it } from "vitest";
import { controlLogLines } from "./controlLogLogic";

describe("control log filtering", () => {
  it("strips terminal escape sequences and searches literal text case-insensitively", () => {
    expect(controlLogLines("\x1b[31m[ERROR] arm[0]\x1b[0m\r\nINFO ready\n", "ARM[0]")).toEqual(["[ERROR] arm[0]"]);
    expect(controlLogLines("\x1b]8;;https://example.test\x07link\x1b]8;;\x07\n")).toEqual(["link"]);
    expect(controlLogLines("", "x")).toEqual([]);
    expect(controlLogLines("one\ntwo", "missing")).toEqual([]);
  });
});
