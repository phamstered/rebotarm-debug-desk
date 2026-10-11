import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOINT4_CALIBRATION_STATUS_TOPIC } from "./joint4CalibrationLogic";

const doubles = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
  request: vi.fn().mockResolvedValue({ op: "subscribed" }),
  listener: undefined as ((message: unknown) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: doubles.save }));

import { Joint4CalibrationPage } from "./Joint4CalibrationPage";
import { defaultProfile } from "./types";

const bridge = {
  request: doubles.request,
  onMessage(listener: (message: unknown) => void) { doubles.listener = listener; return () => {}; },
} as never;

function emitStatus(overrides: Partial<Record<number, number>> = {}) {
  const data = [0.4, 0.005, 1.2, 0.2, 1.4, 0.3, 0.39, 1.7, 3, 1, 0, 0];
  Object.entries(overrides).forEach(([index, value]) => {
    if (value !== undefined) data[Number(index)] = value;
  });
  act(() => doubles.listener?.({ op: "topic_message", topic: JOINT4_CALIBRATION_STATUS_TOPIC, data: { data } }));
}

describe("Joint4CalibrationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.request.mockResolvedValue({ op: "subscribed" });
    doubles.invoke.mockImplementation((_command: string, args?: { action?: string }) => {
      if (args?.action === "capture_pose") return Promise.resolve({
        success: true,
        message: "captured sample 4: q4=0.41000, model=1.23000 Nm, required=1.45000 Nm, payload_sensitivity=0.32000 Nm/kg",
      });
      if (args?.action === "fit") return Promise.resolve({
        success: true,
        message: "samples=4; gravity_scale=1.100000; constant_bias=0.020000 Nm; gravity_rmse=0.030000 Nm; equivalent_payload_mass=0.080000 kg; payload_bias=0.010000 Nm; payload_rmse=0.040000 Nm",
      });
      return Promise.resolve({ success: true, message: `${args?.action} ok` });
    });
  });

  it("subscribes status, gates capture on hands clear, records a sample and shows fit", async () => {
    const user = userEvent.setup();
    render(<Joint4CalibrationPage profile={defaultProfile} bridge={bridge} controllerState="active" onRefreshControllers={vi.fn()} />);
    await waitFor(() => expect(doubles.request).toHaveBeenCalledWith({
      op: "subscribe", topic: JOINT4_CALIBRATION_STATUS_TOPIC, type: "std_msgs/msg/Float64MultiArray",
    }));
    emitStatus();
    expect(screen.getByRole("button", { name: "Capture Pose" })).toBeDisabled();
    await user.click(screen.getByLabelText("手部支撑已逐渐撤掉，当前没有人为外力"));
    await user.click(screen.getByRole("button", { name: "Capture Pose" }));
    expect(await screen.findByText("0.4100")).toBeVisible();
    expect(doubles.invoke).toHaveBeenCalledWith("call_joint4_calibration_service", {
      profile: defaultProfile, action: "capture_pose",
    });

    emitStatus({ 8: 4, 9: 0, 11: 0 });
    await user.click(screen.getByRole("button", { name: "执行 Fit" }));
    expect(await screen.findByText("1.100000")).toBeVisible();
    expect(screen.getByText("0.080000")).toBeVisible();
    expect(screen.getByText(/不会修改 URDF、YAML/)).toBeVisible();
  });

  it("blocks capture on safety fault but permits supported Begin Pose recovery", async () => {
    const user = userEvent.setup();
    render(<Joint4CalibrationPage profile={defaultProfile} bridge={bridge} controllerState="active" onRefreshControllers={vi.fn()} />);
    emitStatus({ 1: 0, 9: 0, 10: 1 });
    expect(screen.getByRole("alert")).toHaveTextContent("控制器已触发 safety_fault");
    expect(screen.getByRole("alert")).toHaveTextContent("托住 joint4");
    expect(screen.getByRole("button", { name: "Capture Pose" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Begin Pose" })).toBeDisabled();
    await user.click(screen.getByLabelText(/我已托住机械臂/));
    expect(screen.getByRole("button", { name: "Begin Pose" })).toBeEnabled();
    expect(screen.getByText(/重建参考并清除旧版 Controller/)).toBeVisible();
  });

  it("locks further sampling after a service failure until safety release succeeds", async () => {
    const user = userEvent.setup();
    doubles.invoke.mockRejectedValueOnce(new Error("service unavailable"));
    render(<Joint4CalibrationPage profile={defaultProfile} bridge={bridge} controllerState="active" onRefreshControllers={vi.fn()} />);
    emitStatus({ 1: 0, 7: 0, 9: 0 });
    await user.click(screen.getByLabelText(/我已托住机械臂/));
    await user.click(screen.getByRole("button", { name: "Begin Pose" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上一次服务调用失败，采样已锁定");
    await user.click(screen.getByRole("button", { name: "安全停止 · Release" }));
    expect(await screen.findByText("release_pose ok")).toBeVisible();
  });

  it("saves locally recorded samples as JSON", async () => {
    const user = userEvent.setup();
    doubles.save.mockResolvedValue("/tmp/joint4.json");
    render(<Joint4CalibrationPage profile={defaultProfile} bridge={bridge} controllerState="active" onRefreshControllers={vi.fn()} />);
    emitStatus();
    await user.click(screen.getByLabelText("手部支撑已逐渐撤掉，当前没有人为外力"));
    await user.click(screen.getByRole("button", { name: "Capture Pose" }));
    await user.click(await screen.findByRole("button", { name: "保存 JSON" }));
    expect(doubles.invoke).toHaveBeenCalledWith("save_joint4_calibration_report", expect.objectContaining({
      localPath: "/tmp/joint4.json",
      content: expect.stringContaining('"advisoryOnly": true'),
    }));
  });
});
