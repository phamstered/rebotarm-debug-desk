import { fireEvent, render, screen } from "@testing-library/react";
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
it("retains history, pauses follow only on user scrolling and resumes without losing records", () => {
  const view = render(<DeployProgressLog lines={["first", "second"]} />);
  const log = screen.getByRole("log", { name: "Bridge 升级日志输出" });
  Object.defineProperties(log, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } });
  log.scrollTop = 0;
  fireEvent.scroll(log);
  expect(screen.getByRole("checkbox", { name: "跟随最新" })).toBeChecked();
  fireEvent.wheel(log); fireEvent.scroll(log);
  expect(screen.getByRole("checkbox", { name: "跟随最新" })).not.toBeChecked();
  view.rerender(<DeployProgressLog lines={["first", "second", "third"]} />);
  expect(log.scrollTop).toBe(0);
  expect(log).toHaveTextContent("first"); expect(log).toHaveTextContent("third");
  fireEvent.click(screen.getByRole("checkbox", { name: "跟随最新" }));
  expect(log.scrollTop).toBe(1000);
  Object.defineProperty(log, "scrollHeight", { value: 1200 });
  view.rerender(<DeployProgressLog lines={["first", "second", "third", "fourth"]} />);
  expect(log.scrollTop).toBe(1200);
});
