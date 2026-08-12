import { act, fireEvent, render, screen } from "@testing-library/react";
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
    render(<MotorControl bridge={bridge as unknown as BridgeClient} jointState={{ position: [.15], velocity: [0] }} status={{ fault_code: 3, mode_name: "DISABLE" }} onStreamingChange={() => {}} />);
    expect(screen.getByLabelText("MIT 命令模式")).toHaveValue("1");
    expect(screen.getByLabelText("Kp")).toHaveValue("8");
    expect(screen.getByLabelText("Kd")).toHaveValue("2");
    expect(screen.getByRole("status")).toHaveTextContent("FAULT 3 · COMMAND_LIMIT");
  });

  it("arming once does not overwrite an edited position", async () => {
    const bridge = bridgeDouble();
    const user = userEvent.setup();
    render(<MotorControl bridge={bridge as unknown as BridgeClient} jointState={{ position: [.15] }} status={null} onStreamingChange={() => {}} />);
    const position = screen.getByLabelText("Position · rad");
    await user.clear(position);
    await user.type(position, "0.6");
    await user.click(screen.getByRole("checkbox"));
    expect(position).toHaveValue("0.6");
    await user.click(screen.getByRole("button", { name: "使用当前位置" }));
    expect(position).toHaveValue("0.15");
  });

  it("starts a 20 Hz TRACK stream and keeps confirmation after DISABLE", async () => {
    vi.useFakeTimers();
    const bridge = bridgeDouble();
    const streaming = vi.fn();
    render(<MotorControl bridge={bridge as unknown as BridgeClient} jointState={{ position: [0] }} status={null} onStreamingChange={streaming} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "开始 20 Hz 发送" }));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.request).toHaveBeenCalledWith(expect.objectContaining({ mode: 1, kp: 8, kd: 2 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(streaming).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" }));
    await act(async () => { await Promise.resolve(); });
    expect(bridge.request).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("rejects out-of-range effort before sending", async () => {
    const bridge = bridgeDouble();
    const user = userEvent.setup();
    render(<MotorControl bridge={bridge as unknown as BridgeClient} jointState={null} status={null} onStreamingChange={() => {}} />);
    await user.click(screen.getByRole("checkbox"));
    const effort = screen.getByLabelText("Effort · Nm");
    await user.clear(effort);
    await user.type(effort, "1.1");
    await user.click(screen.getByRole("button", { name: "开始 20 Hz 发送" }));
    expect(await screen.findByText("Effort 必须在 -1 到 1 之间")).toBeVisible();
    expect(bridge.request).not.toHaveBeenCalled();
  });
});
