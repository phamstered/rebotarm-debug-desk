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
    expect(
      screen.getByText(/当前任务未提供逐关节完成\/停止核验诊断明细/),
    ).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("requires owned command identity and group metadata", () => {
    const view = render(<MotionGroupResult state={state({ commandId: "" })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    view.rerender(<MotionGroupResult state={state({ group: undefined })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("separates the captured actual hold baseline from a later stopped nominal-target verification", () => {
    render(
      <MotionGroupResult
        state={state({
          phase: "canceled",
          message: "保持偏移，取消后已停稳",
          holdFailure: {
            reason: "position_drift",
            phase: "holding",
            capturedAtMs: 1793600000123,
            feedbackAgeMs: 7,
            stableForMs: 0,
            requiredStableMs: 200,
            samples: [
              {
                ...diagnostics[0],
                target: 0.5,
                actual: 0.531,
                position_error: 0.031,
              },
            ],
          },
          arrivalErrors: [
            {
              ...diagnostics[0],
              target: 0,
              actual: 0.532,
              position_error: 0.532,
              velocity: 0,
            },
          ],
        })}
      />,
    );
    const trigger = screen.getByRole("region", { name: "异常触发快照" });
    const verification = screen.getByRole("region", {
      name: "完成/停止核验快照",
    });
    expect(trigger).toHaveTextContent("保持位置偏移超限，触发取消");
    expect(trigger).toHaveTextContent("触发时间（Jetson）");
    expect(within(trigger).getByTitle("1793600000123 ms")).toHaveTextContent(
      "2026年11月02日 06:13:20.123 UTC",
    );
    expect(trigger).toHaveTextContent("反馈年龄 7 ms");
    expect(trigger).toHaveTextContent("保持偏移超限关节：joint4");
    expect(trigger).not.toHaveTextContent("连续停稳");
    expect(trigger).toHaveTextContent("保持基准 0.5 rad（28.64789°）");
    expect(trigger).toHaveTextContent("触发时 0.531 rad");
    expect(trigger).toHaveTextContent("偏移 0.031 rad");
    expect(trigger).toHaveTextContent("保持阈值 0.02 rad");
    expect(trigger).toHaveTextContent(
      "保持基准取进入保持时的实际反馈，并非本帧名义目标",
    );
    expect(verification).toHaveTextContent("目标为本帧名义目标");
    expect(verification).toHaveTextContent("目标 0 rad（0°）");
    expect(verification).toHaveTextContent("实际 0.532 rad");
    expect(verification).toHaveTextContent("速度 0 rad/s");
    expect(verification).not.toHaveTextContent("保持基准 0.5");
    expect(trigger).not.toHaveTextContent("实际 0.532");
    expect(screen.getByText(/运动完成时，位置误差仅供诊断/)).toBeVisible();
  });
  it("does not blame an axis for velocity timeout when the capture is already low-speed", () => {
    render(
      <MotionGroupResult
        state={state({
          phase: "canceled",
          message: "未连续停稳，已取消",
          holdFailure: {
            reason: "velocity_timeout",
            phase: "paused",
            capturedAtMs: 456,
            feedbackAgeMs: 9,
            stableForMs: 80,
            requiredStableMs: 200,
            samples: diagnostics,
          },
          arrivalErrors: [{ ...diagnostics[0], velocity: 0 }],
        })}
      />,
    );
    const trigger = screen.getByRole("region", { name: "异常触发快照" });
    expect(trigger).toHaveTextContent(
      "段间暂停 · 触发时间（Jetson） 1970年01月01日 00:00:00.456 UTC · 反馈年龄 9 ms",
    );
    expect(trigger).toHaveTextContent("连续停稳 80 / 要求 200 ms");
    expect(trigger).toHaveTextContent(
      "触发快照中未见单轴速度超限；连续停稳条件未满足",
    );
    expect(trigger).not.toHaveTextContent("采样速度超限关节：");
    expect(trigger).not.toHaveTextContent("保持偏移超限关节：");
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });
  it("names only sample-supported trigger axes and treats the exact threshold as within bounds", () => {
    const samples = [
      {
        ...diagnostics[0],
        joint_name: "joint1",
        velocity: -0.03,
        position_error: 0.001,
      },
      {
        ...diagnostics[0],
        joint_name: "joint2",
        velocity: 0.02,
        position_error: 1,
      },
      { ...diagnostics[1], velocity: -0.002 },
    ];
    const failure = {
      reason: "velocity_timeout" as const,
      phase: "holding" as const,
      capturedAtMs: 999,
      feedbackAgeMs: 1,
      samples,
    };
    const view = render(
      <MotionGroupResult state={state({ holdFailure: failure })} />,
    );
    let trigger = screen.getByRole("region", { name: "异常触发快照" });
    expect(trigger).toHaveTextContent(
      "采样速度超限关节：joint1、gripper_finger_left_joint",
    );
    expect(
      within(trigger).getByText(/^采样速度超限关节：/),
    ).not.toHaveTextContent("joint2");
    view.rerender(
      <MotionGroupResult
        state={state({
          holdFailure: {
            ...failure,
            reason: "position_drift",
            samples: [
              { ...samples[0], position_error: -0.03 },
              { ...samples[1], position_error: 0.02 },
              { ...samples[2], position_error: 0.001 },
            ],
          },
        })}
      />,
    );
    trigger = screen.getByRole("region", { name: "异常触发快照" });
    expect(within(trigger).getByText(/^保持偏移超限关节：/)).toHaveTextContent(
      "保持偏移超限关节：joint1",
    );
    expect(
      within(trigger).getByText(/^保持偏移超限关节：/),
    ).not.toHaveTextContent("joint2");
    expect(
      within(trigger).getByText(/^保持偏移超限关节：/),
    ).not.toHaveTextContent("gripper");
  });
  it("keeps the original hold failure if no sample proves a position-drift axis, with no invented joint name", () => {
    render(
      <MotionGroupResult
        state={state({
          message: "Bridge 保持偏移检查失败",
          holdFailure: {
            reason: "position_drift",
            phase: "holding",
            capturedAtMs: 0,
            feedbackAgeMs: 0,
            samples: [{ ...diagnostics[0], position_error: 0.01 }],
          },
        })}
      />,
    );
    const trigger = screen.getByRole("region", { name: "异常触发快照" });
    expect(trigger).toHaveTextContent(
      "触发快照未显示超阈值关节，保留 Bridge 原始原因",
    );
    expect(trigger).not.toHaveTextContent("保持偏移超限关节：");
    expect(screen.getByText(/Bridge 保持偏移检查失败/)).toBeVisible();
    expect(
      screen.queryByRole("region", { name: "完成/停止核验快照" }),
    ).not.toBeInTheDocument();
  });
  it("keeps old Bridge diagnostics compatible without fabricating a trigger capture", () => {
    render(<MotionGroupResult state={state({ arrivalErrors: diagnostics })} />);
    expect(
      screen.queryByRole("region", { name: "异常触发快照" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "完成/停止核验快照" }),
    ).toBeVisible();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.queryByText(/触发取消/)).not.toBeInTheDocument();
  });
  it("falls back to the raw trigger milliseconds outside the representable Date range", () => {
    render(
      <MotionGroupResult
        state={state({
          holdFailure: {
            reason: "position_drift",
            phase: "holding",
            capturedAtMs: 1e20,
            feedbackAgeMs: 1,
            samples: diagnostics,
          },
        })}
      />,
    );
    expect(screen.getByTitle("100000000000000000000 ms")).toHaveTextContent(
      "100000000000000000000 ms",
    );
    expect(
      screen.getByRole("region", { name: "异常触发快照" }),
    ).toHaveTextContent("触发时间（Jetson）");
  });
});
