import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GravityIdentificationPage } from "./GravityIdentificationPage";

const doubles = vi.hoisted(() => ({
  request: vi.fn().mockResolvedValue({ op: "gravity_id_send_goal_ack", accepted: true }),
  listener: undefined as ((message: unknown) => void) | undefined,
  onSession: vi.fn(),
  onCalib: vi.fn(),
}));

const bridge = {
  request: doubles.request,
  onMessage(listener: (message: unknown) => void) {
    doubles.listener = listener;
    return () => undefined;
  },
} as never;

describe("GravityIdentificationPage", () => {
  it("gates Start behind ARMED and sends gravity_id_send_goal", async () => {
    const user = userEvent.setup();
    render(
      <GravityIdentificationPage
        bridge={bridge}
        onNavigateCalibration={doubles.onCalib}
        onSessionActiveChange={doubles.onSession}
      />,
    );

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "安全确认" }));
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(doubles.request).toHaveBeenCalled());
    const payload = doubles.request.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.op).toBe("gravity_id_send_goal");
    expect(payload.confirmation).toBe("ARMED");
    expect(payload.joint_mask).toBe(0x3f);
    expect(payload.mode).toBe(0);
  });

  it("shows feedback and result; Abort always while running", async () => {
    const user = userEvent.setup();
    render(
      <GravityIdentificationPage
        bridge={bridge}
        onNavigateCalibration={doubles.onCalib}
        onSessionActiveChange={doubles.onSession}
      />,
    );

    act(() => {
      doubles.listener?.({
        op: "gravity_id_feedback",
        phase: 5,
        pose_index: 2,
        pose_count: 8,
        active_joint_mask: 63,
        residual_nm: [0.1, 0, 0, 0, 0, 0],
        measured_effort_nm: [1, 0, 0, 0, 0, 0],
        model_effort_nm: [0.9, 0, 0, 0, 0, 0],
        rmse_running: 0.2,
        fault_code: 0,
        message: "capturing pose 2",
      });
    });

    expect(screen.getByText("CAPTURING")).toBeVisible();
    expect(screen.getByText("2/8")).toBeVisible();
    expect(screen.getByText("capturing pose 2")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Abort" }));
    await waitFor(() => {
      expect(doubles.request).toHaveBeenCalledWith(
        expect.objectContaining({ op: "gravity_id_cancel" }),
      );
    });

    act(() => {
      doubles.listener?.({
        op: "gravity_id_result",
        success: true,
        fault_code: 0,
        gravity_scales: [1, 1, 1, 1, 1, 1],
        torque_biases_nm: [0, 0, 0, 0, 0, 0],
        rmse_per_joint: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
        rmse_total: 0.02,
        yaml_path: "/tmp/g.yaml",
        message: "done",
      });
    });
    expect(screen.getByText("/tmp/g.yaml")).toBeVisible();
  });

  it("links PAYLOAD mode to Joint4 Calibration", async () => {
    const user = userEvent.setup();
    render(
      <GravityIdentificationPage
        bridge={bridge}
        onNavigateCalibration={doubles.onCalib}
        onSessionActiveChange={doubles.onSession}
      />,
    );
    await user.selectOptions(screen.getByLabelText("辨识模式"), "1");
    expect(screen.getByRole("button", { name: "打开 Joint4 标定" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getAllByText(/v1 only supports FULL_ARM|拒绝 PAYLOAD_SUBMODE/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "打开 Joint4 标定" }));
    expect(doubles.onCalib).toHaveBeenCalled();
  });
});
