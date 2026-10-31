import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { JointRotationPanel } from "./JointRotationPanel";
import type { KinematicJoint } from "./kinematicsLogic";

it("rejects a nonfinite continuous target while keeping the slider range finite", () => {
  const joint: KinematicJoint = { name: "joint1", type: "continuous", parent: "base", child: "tool",
    origin: [0, 0, 0], rpy: [0, 0, 0], axis: [0, 0, 1], lower: -Infinity, upper: Infinity };
  const preview = vi.fn();
  render(<JointRotationPanel joints={[joint]} selected="joint1" jointState={{ name: ["joint1"], position: [0] }}
    active hasPreview={false} onSelect={vi.fn()} onPreview={preview} />);
  fireEvent.change(screen.getByLabelText("目标关节角度"), { target: { value: "Infinity" } });
  expect(screen.getByRole("alert")).toHaveTextContent("有效的目标角度");
  expect(screen.getByRole("slider")).toHaveAttribute("min", "-180");
  expect(screen.getByRole("slider")).toHaveAttribute("max", "180");
  expect(preview).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
});
