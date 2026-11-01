import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ClockSyncStatus } from "./ClockSyncStatus";
it("shows the Jetson-reported sign and keeps diagnostic details collapsed", () => {
  const view = render(<ClockSyncStatus value={{ supported: true, state: "unsynchronized", source_topic: "/stm32/joint_states", message: "等待重新同步", generation: 2, source_offset_ms: 15400, feedback_age_ms: 5 }} />);
  expect(screen.getByText(/时钟同步 · 时间失步/)).toBeVisible();
  expect(screen.getByText(/超前 15400.0 ms/)).toBeVisible();
  expect(screen.getByText(/相对 Jetson/).closest("details")).not.toHaveAttribute("open");
  view.rerender(<ClockSyncStatus value={{ supported: true, state: "synchronized", source_topic: "/stm32/joint_states", message: "时间恢复", generation: 2, source_offset_ms: -3, feedback_age_ms: 5 }} />);
  expect(screen.getByText(/落后 3.0 ms/)).toBeVisible();
});
