import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotorControl } from "./MotorControl";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope } from "./types";

function bridgeDouble() {
  let listener: ((message: BridgeEnvelope) => void) | undefined;
  return {
    request: vi.fn().mockResolvedValue({ op: "joint_command_ack", sequence: 42 }),
    send: vi.fn(),
    onMessage: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }),
    emit: (message: BridgeEnvelope) => listener?.(message),
  };
}

afterEach(() => vi.useRealTimers());

describe("MotorControl", () => {
  it("renders TRACK and Kp/Kd defaults and reports fault details", () => {
    const bridge = bridgeDouble();
    render(
      <MotorControl
        bridge={bridge as unknown as BridgeClient}
        jointState={{ name: ["joint1"], position: [0.15], velocity: [0] }}
        status={{ fault_code: 3, mode_name: "DISABLE", active_joint_mask: 1, active_joints: [0] }}
        onStreamingChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("MIT 命令模式")).toHaveValue("1");
    expect(screen.getByLabelText("Kp")).toHaveValue("8");
    expect(screen.getByLabelText("Kd")).toHaveValue("2");
    expect(screen.getByRole("status")).toHaveTextContent("FAULT 3 · COMMAND_LIMIT");
    expect(screen.getByLabelText("joint1 使能")).not.toBeChecked();
  });

  it("arming once does not overwrite an edited position", async () => {
    const bridge = bridgeDouble();
    const user = userEvent.setup();
    render(
      <MotorControl
        bridge={bridge as unknown as BridgeClient}
        jointState={{ name: ["joint1"], position: [0.15] }}
        status={null}
        onStreamingChange={() => {}}
      />,
    );
    await user.click(screen.getByLabelText("joint1 使能"));
    const position = screen.getByLabelText("joint1 Position · rad");
    await user.clear(position);
    await user.type(position, "0.6");
    await user.click(screen.getByLabelText("安全确认"));
    expect(position).toHaveValue("0.6");
    await user.click(screen.getByRole("button", { name: "使用当前位置" }));
    expect(position).toHaveValue("0.15");
  });

  it("starts a 20 Hz TRACK stream only for enabled joints", async () => {
    vi.useFakeTimers();
    const bridge = bridgeDouble();
    const streaming = vi.fn();
    render(
      <MotorControl
        bridge={bridge as unknown as BridgeClient}
        jointState={{ name: ["joint1", "joint2"], position: [0, 0.1] }}
        status={null}
        onStreamingChange={streaming}
      />,
    );
    fireEvent.click(screen.getByLabelText("joint1 使能"));
    fireEvent.click(screen.getByLabelText("joint2 使能"));
    const joint2Position = screen.getByLabelText("joint2 Position · rad");
    fireEvent.change(joint2Position, { target: { value: "0.2" } });
    fireEvent.click(screen.getByLabelText("安全确认"));
    fireEvent.click(screen.getByRole("button", { name: "开始 20 Hz 发送" }));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({
      mode: 1,
      kp: 8,
      kd: 2,
      active_joint_mask: 0x03,
      position: [0, 0.2],
      confirmation: "ARMED",
    }));
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(streaming).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" }));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.request).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 3, active_joint_mask: 0, position: [],
    }));
    expect(screen.getByLabelText("安全确认")).toBeChecked();
  });

  it("rejects out-of-range effort and empty enable set before sending", async () => {
    const bridge = bridgeDouble();
    const user = userEvent.setup();
    render(
      <MotorControl
        bridge={bridge as unknown as BridgeClient}
        jointState={{ name: ["joint1"], position: [0] }}
        status={null}
        onStreamingChange={() => {}}
      />,
    );
    await user.click(screen.getByLabelText("安全确认"));
    await user.click(screen.getByRole("button", { name: "开始 20 Hz 发送" }));
    expect(await screen.findByText("请至少使能一个电机")).toBeVisible();
    expect(bridge.request).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText("joint1 使能"));
    const effort = screen.getByLabelText("Effort · Nm");
    await user.clear(effort);
    await user.type(effort, "1.1");
    await user.click(screen.getByRole("button", { name: "开始 20 Hz 发送" }));
    expect(await screen.findByText("Effort 必须在 -1 到 1 之间")).toBeVisible();
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("exposes configurable travel bounds for the slider", () => {
    const bridge = bridgeDouble();
    render(
      <MotorControl
        bridge={bridge as unknown as BridgeClient}
        jointState={{ name: ["joint1"], position: [0] }}
        status={null}
        onStreamingChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-0.35");
    expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("0.35");
    const slider = screen.getByLabelText("joint1 Position 滑块");
    expect(slider).toHaveAttribute("min", "-0.35");
    expect(slider).toHaveAttribute("max", "0.35");
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
  });
});
