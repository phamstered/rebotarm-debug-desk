import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MotionControlPanel } from "./MotionControlPanel";

describe("MotionControlPanel", () => {
  it("shows an empty motion state", () => {
    render(<MotionControlPanel info={{ state: "idle" }} />);
    expect(screen.getByRole("region", { name: "运动控制" })).toHaveTextContent("无运动");
  });

  it("shows settled command error in the panel", () => {
    render(
      <MotionControlPanel
        info={{
          state: "settled",
          label: "取料位",
          outcome: "done",
          maxAbsJointRad: 0.004,
          tcpPositionMm: 1.2,
          tcpOrientationDeg: 0.4,
          perJoint: [{ name: "joint1", deltaRad: 0.004 }],
        }}
      />,
    );
    const panel = screen.getByRole("region", { name: "运动控制" });
    expect(panel).toHaveTextContent("取料位");
    expect(panel).toHaveTextContent("0.004 rad");
    expect(panel).toHaveTextContent("1.2 mm");
    expect(panel).toHaveTextContent("0.4°");
  });
  it("keeps MoveIt motion visible when returning from the positions tab", () => {
    render(<MotionControlPanel info={{ state: "position", label: "取料位", phase: "executing", message: "MoveIt 正在执行" }} />);
    expect(screen.getByRole("region", { name: "运动控制" })).toHaveTextContent("MoveIt 正在执行");
    expect(screen.queryByText("无运动")).not.toBeInTheDocument();
  });

});
