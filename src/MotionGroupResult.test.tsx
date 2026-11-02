import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MotionGroupResult } from "./MotionGroupResult";
import type { PositionMotionState } from "./positionMotionLogic";
const state = (
  changes: Partial<PositionMotionState> = {},
): PositionMotionState => ({
  commandId: "owned-group",
  label: "HOME 取放",
  phase: "failed",
  message: "Action 返回失败：PATH_TOLERANCE_VIOLATED",
  code: -4,
  group: {
    id: "group",
    index: 0,
    count: 3,
    phase: "preparing",
    elapsed: 5.3,
    stepLabel: "HOME",
  },
  positionErrorCheckEnforced: false,
  ...changes,
});
const diagnostics = [
  {
    joint_name: "joint4",
    target: 0,
    actual: 0.043679,
    position_error: 0.043679,
    position_tolerance: 0.02,
    velocity: 0.003,
    velocity_tolerance: 0.02,
    unit: "rad" as const,
  },
  {
    joint_name: "gripper_finger_left_joint",
    target: 0.01,
    actual: 0.012,
    position_error: 0.002,
    position_tolerance: 0.001,
    velocity: 0.0002,
    velocity_tolerance: 0.001,
    unit: "m" as const,
  },
];
describe("MotionGroupResult", () => {
  it("keeps a failed preparation's original reason, affected frame and follow-on outcome visible", () => {
    render(<MotionGroupResult state={state({ arrivalErrors: diagnostics })} />);
    const result = screen.getByRole("status", { name: "最近动作组执行结果" });
    expect(result).toHaveTextContent("最近执行的「HOME 取放」动作组");
    expect(result).toHaveTextContent("执行失败");
    expect(result).toHaveTextContent("第 1/3 帧 · HOME · 首帧准备");
    expect(result).toHaveTextContent(
      "Action 返回失败：PATH_TOLERANCE_VIOLATED（代码 -4）",
    );
    expect(result).toHaveTextContent("后续关键帧未执行");
    expect(result).toHaveAttribute("aria-live", "polite");
    expect(document.activeElement).toBe(document.body);
  });
  it("shows radians/degrees and meters/millimeters with reference values and stop-velocity thresholds", () => {
    render(<MotionGroupResult state={state({ arrivalErrors: diagnostics })} />);
    const rows = within(
      screen.getByRole("table", { name: "关节到位诊断" }),
    ).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("误差 0.043679 rad（2.502622°）");
    expect(rows[1]).toHaveTextContent("参考 0.02 rad（1.145916°）");
    expect(rows[1]).toHaveTextContent("速度 0.003 rad/s（0.171887°/s）");
    expect(rows[1]).toHaveTextContent("停稳阈值 0.02 rad/s");
    expect(rows[2]).toHaveTextContent("目标 0.01 m（10 mm）");
    expect(rows[2]).toHaveTextContent("实际 0.012 m（12 mm）");
    expect(rows[2]).toHaveTextContent("误差 0.002 m（2 mm）");
    expect(rows[2]).toHaveTextContent("速度 0.0002 m/s（0.2 mm/s）");
    expect(rows[2]).toHaveTextContent("停稳阈值 0.001 m/s（1 mm/s）");
  });
  it("reports success even when position diagnostic error exceeds its reference", () => {
    render(
      <MotionGroupResult
        state={state({
          phase: "succeeded",
          message: "Action 成功且已停稳",
          arrivalErrors: diagnostics,
        })}
      />,
    );
    const result = screen.getByRole("status", { name: "最近动作组执行结果" });
    expect(result).toHaveTextContent("执行成功");
    expect(result).toHaveTextContent("位置误差仅供诊断，不作为完成门槛");
    expect(result).not.toHaveTextContent("执行失败");
    expect(result).not.toHaveTextContent("后续关键帧未执行");
    expect(result).not.toHaveTextContent("未到位");
  });
  it("distinguishes cancellation from failure without inventing a diagnostic cause", () => {
    render(
      <MotionGroupResult
        state={state({
          phase: "canceled",
          message: "用户取消",
          group: {
            id: "group",
            index: 1,
            count: 3,
            phase: "holding",
            elapsed: 7,
            stepLabel: "B",
          },
        })}
      />,
    );
    expect(
      screen.getByRole("status", { name: "最近动作组执行结果" }),
    ).toHaveTextContent("已取消");
    expect(screen.getByText(/第 2\/3 帧 · B · 停留/)).toBeVisible();
    expect(screen.queryByText(/后续关键帧未执行/)).not.toBeInTheDocument();
    expect(
      screen.getByText("动作组已取消，后续关键帧不再继续。"),
    ).toBeVisible();
  });
  it("keeps rejected starts and old Bridge responses readable without claiming a known error policy", () => {
    render(
      <MotionGroupResult
        state={state({
          message: "请求被拒绝：Controller inactive",
          positionErrorCheckEnforced: undefined,
          arrivalErrors: undefined,
        })}
      />,
    );
    expect(screen.getByText(/请求被拒绝：Controller inactive/)).toBeVisible();
    expect(
      screen.getByText(/当前 Bridge 未声明位置误差完成策略/),
    ).toBeVisible();
    expect(screen.queryByText(/位置误差仅供诊断/)).not.toBeInTheDocument();
    expect(screen.getByText(/当前任务未提供逐关节诊断明细/)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("requires owned command identity and group metadata", () => {
    const view = render(<MotionGroupResult state={state({ commandId: "" })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<MotionGroupResult state={state({ group: undefined })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
