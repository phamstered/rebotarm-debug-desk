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
  fireEvent.change(screen.getByLabelText("joint1 目标角度"), { target: { value: "Infinity" } });
  expect(screen.getByRole("alert")).toHaveTextContent("有效的目标角度");
  expect(screen.getByRole("slider")).toHaveAttribute("min", "-180");
  expect(screen.getByRole("slider")).toHaveAttribute("max", "180");
  expect(preview).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
});

it("keeps six targets across selection and feedback, and submits one timed command", () => {
  const names = ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6"];
  const joints: KinematicJoint[] = names.map((name) => ({ name, type: "revolute", parent: "base", child: name,
    origin: [0,0,0], rpy: [0,0,0], axis: [0,0,1], lower: -3, upper: 3 }));
  const executeJoints = vi.fn(); const preview = vi.fn();
  const motion = { state: { phase: "idle" as const, commandId: "", label: "", message: "" }, homePositions: [],
    reason: "", jointRotationReason: "", jointTargetsReason: "", armed: true, busy: false, setArmed: vi.fn(),
    execute: vi.fn(), executeJoint: vi.fn(), executeJoints, cancel: vi.fn() };
  const props = { joints, selected: "joint1", jointState: { name: names, position: [0,0,0,0,0,0] }, active: true,
    motion, hasPreview: true, onSelect: vi.fn(), onPreview: preview };
  const view = render(<JointRotationPanel {...props} />);
  names.forEach((name, i) => fireEvent.change(screen.getByLabelText(`${name} 目标角度`), { target: { value: String(i+1) } }));
  view.rerender(<JointRotationPanel {...props} selected="joint6" jointState={{ name: names, position: [.1,.1,.1,.1,.1,.1] }} />);
  names.forEach((name, i) => expect(screen.getByLabelText(`${name} 目标角度`)).toHaveValue(String(i+1)));
  expect(executeJoints).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("运动时长（秒）"), { target: { value: "0" } });
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("运动时长（秒）"), { target: { value: ".05" } });
  expect(screen.getByRole("button", { name: "确认执行" })).not.toBeDisabled();
  view.rerender(<JointRotationPanel {...props} motion={{ ...motion, state: { ...motion.state, recommendedDuration: 2.5 } }} />);
  expect(screen.getByText(/最近规划推荐时长 2.500 秒/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("运动时长（秒）"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(executeJoints).toHaveBeenCalledTimes(1);
  const expected = Object.fromEntries(names.map((name, i) => [name, (i+1)*Math.PI/180]));
  expect(executeJoints).toHaveBeenCalledWith(expected, 5);
  expect(preview).toHaveBeenCalledWith(expected);
});
