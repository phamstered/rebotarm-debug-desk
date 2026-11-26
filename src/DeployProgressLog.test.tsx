import { readTerminal } from "./terminalLogLogic";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DeployProgressLog } from "./DeployProgressLog";
import { appendDeployLog, DEPLOY_LOG_MAX_LINES } from "./deployLogLogic";

it("appends multiline output without terminal escapes and bounds retained history", () => {
  expect(appendDeployLog(["[build] start"], "\x1b[31mfirst\x1b[0m\r\nsecond\n")).toEqual(["[build] start", "first", "second"]);
  expect(appendDeployLog(["ready"], "")).toEqual(["ready"]);
  const lines = appendDeployLog(Array.from({ length: DEPLOY_LOG_MAX_LINES }, (_, i) => String(i)), "new\n" + "x".repeat(5000));
  expect(lines).toHaveLength(DEPLOY_LOG_MAX_LINES);
  expect(lines[0]).toBe("2");
  expect(lines.at(-2)).toBe("new");
  expect(lines.at(-1)).toHaveLength(4096);
});
it("publishes successive deployment lines to Terminal without a second output pane", async () => {
  const view=render(<DeployProgressLog lines={["deploy first", "deploy second"]}/>);
  view.rerender(<DeployProgressLog lines={["deploy first", "deploy second", "deploy third"]}/>);
  expect(screen.queryByRole("log")).toBeNull();
  expect(screen.getByRole("button",{name:"查看部署日志"})).toBeVisible();
  const rows=(await readTerminal(0)).entries.filter(e=>e.source==="Deploy");
  expect(rows.filter(e=>e.message==="deploy first")).toHaveLength(1);
  expect(rows.some(e=>e.message==="deploy third")).toBe(true);
});
