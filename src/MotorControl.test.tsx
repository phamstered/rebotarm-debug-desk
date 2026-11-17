import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotorControl } from "./MotorControl";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope, MotorControlCapabilities } from "./types";

function capabilities(patch: Partial<MotorControlCapabilities> = {}): MotorControlCapabilities {
  return { supported: true, fresh: true, reason: "", age_ms: 0, protocol_version: 2, boot_id: "9007199254740993", control_epoch: 2, source_id: "5", owner_source_id: "0", lease_id: 0, selected_joint_mask: 0, enabled_joint_mask: 0, verified_joint_mask: 127, pos_vel_supported_mask: 63, control_modes: Array(7).fill("MIT"), velocity_limit_max: Array(7).fill(2), position_min: Array(7).fill(-3), position_max: Array(7).fill(3), switching: false, disabled_verified: true, operation_id: 0, operation_state: 0, last_command_sequence: 40, mode: 3, fault_code: 0, error_code: 0, rejected_sequence: 0, reject_code: 0, stamp_ns: "1000000000", ...patch };
}
function bridgeDouble(initial: MotorControlCapabilities | null = null) {
  let listener: ((message: BridgeEnvelope) => void) | undefined;
  let current = initial;
  const command = vi.fn<(request: BridgeEnvelope) => Promise<BridgeEnvelope>>().mockResolvedValue({ op: "joint_command_ack", sequence: 42 });
  const request = vi.fn((value: BridgeEnvelope) => value.op === "motor_capabilities" ? Promise.resolve({ op: "motor_capabilities_result", motor_control: current ?? capabilities({ supported: false, fresh: false, reason: "旧固件未提供 V2" }) }) : command(value));
  return { request, command, send: vi.fn(), onMessage: vi.fn((next) => { listener = next; return () => { listener = undefined; }; }), emit: (message: BridgeEnvelope) => listener?.(message), setCapabilities(value: MotorControlCapabilities) { current = value; } };
}
function mount(bridge = bridgeDouble(), extra: Partial<React.ComponentProps<typeof MotorControl>> = {}) {
  const props = { bridge: bridge as unknown as BridgeClient, jointState: { name: ["joint1", "joint2", "joint3"], position: [0.15, 0.1, 0.2] }, status: null, onStreamingChange: vi.fn(), ...extra };
  return { ...render(<MotorControl {...props} />), props, bridge };
}
async function flush() { await act(async () => {}); }
function select(index = 1) { fireEvent.click(screen.getByLabelText(`joint${index} 选择控制`)); }
function arm() { fireEvent.click(screen.getByLabelText("安全确认")); }
function start(name = "开始控制") { fireEvent.click(screen.getByRole("button", { name })); }
afterEach(() => vi.useRealTimers());

describe("MotorControl legacy MIT", () => {
  it("preserves TRACK/Kp/Kd defaults, reports faults, and uses selection terminology", async () => {
    mount(bridgeDouble(), { status: { fault_code: 3, mode_name: "DISABLE", active_joint_mask: 1, active_joints: [0] } }); await flush();
    expect(screen.getByLabelText("执行状态")).toHaveValue("1");
    expect(screen.getByLabelText("Kp")).toHaveValue("8"); expect(screen.getByLabelText("Kd")).toHaveValue("2");
    expect(screen.getByRole("status")).toHaveTextContent("FAULT 3 · COMMAND_LIMIT");
    expect(screen.getByLabelText("joint1 选择控制")).not.toBeChecked();
    expect(screen.getByText("固件可用轴 joint1")).toBeVisible();
    expect(screen.queryByRole("option", { name: "DISABLE" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "POS_VEL" })).toBeDisabled();
  });
  it("keeps edited position on authorization and revokes authorization on edits/use-current", async () => {
    mount(); await flush(); select(); fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.6" } }); arm();
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.6");
    fireEvent.click(screen.getByRole("button", { name: "使用当前位置" }));
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.15"); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    arm(); fireEvent.change(screen.getByLabelText("Kp"), { target: { value: "80" } }); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
  });
  it("starts one 20 Hz stream with zero unselected channels and keeps STOP independent", async () => {
    vi.useFakeTimers(); const { bridge, props } = mount(); await flush(); await act(async () => bridge.emit({ op: "topic_message", topic: "/stm32/status", data: { header: { stamp: { sec: 1, nanosec: 0 } }, mode: 3, fault_code: 0, last_command_sequence: 40 } })); select(); select(2);
    fireEvent.change(screen.getByLabelText("joint2 Position · rad"), { target: { value: "0.2" } }); arm(); start(); fireEvent.click(screen.getByRole("button", { name: "正在开始…" })); await flush();
    expect(bridge.command).toHaveBeenCalledTimes(1);
    expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: "joint_command", mode: 1, kp: 8, kd: 2, active_joint_mask: 3, position: [0, 0.2, 0, 0, 0, 0, 0], confirmation: "ARMED" }));
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2); expect(props.onStreamingChange).toHaveBeenCalledWith(true);
    expect(screen.getByLabelText("Kp")).toBeDisabled(); expect(screen.getByLabelText("joint1 选择控制")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3, active_joint_mask: 0, position: [] }));
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    expect(screen.getByText(/已请求 DISABLE，停止确认中/)).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2);
    await act(async () => bridge.emit({ op: "topic_message", topic: "/stm32/status", data: { header: { stamp: { sec: 2, nanosec: 0 } }, mode: 3, fault_code: 0, last_command_sequence: 42 } }));
    expect(screen.getByText(/已确认输出关闭/)).toBeVisible(); expect(screen.getByRole("button", { name: "开始控制" })).toBeDisabled();
  });
  it("rejects empty selection and excessive effort, preserving unrestricted MIT numeric targets", async () => {
    const { bridge } = mount(); await flush(); arm(); start(); expect(screen.getByText("请至少选择一个关节")).toBeVisible(); expect(bridge.command).not.toHaveBeenCalled();
    select(); fireEvent.change(screen.getByLabelText("Effort · Nm"), { target: { value: "1.1" } }); arm(); start(); expect(screen.getByText("Effort 必须在 -1 到 1 之间")).toBeVisible(); expect(bridge.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Effort · Nm"), { target: { value: "1" } }); fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Velocity · rad/s"), { target: { value: "30" } }); fireEvent.change(screen.getByLabelText("Kp"), { target: { value: "80" } }); fireEvent.change(screen.getByLabelText("Kd"), { target: { value: "12" } }); arm(); start(); await flush();
    expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ position: [12, 0, 0, 0, 0, 0, 0], velocity: 30, kp: 80, kd: 12, effort: 1 }));
  });
  it("requests DISABLE after an ambiguous first-frame failure instead of assuming nothing was published", async () => {
    const bridge = bridgeDouble(); bridge.command.mockRejectedValueOnce(new Error("ACK timeout")); mount(bridge); await flush(); select(); arm(); start(); await flush();
    expect(bridge.command).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 1 })); expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    expect(screen.getByText(/控制未开始：Error: ACK timeout；已请求停止/)).toBeVisible(); expect(bridge.send).not.toHaveBeenCalled(); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
  });
  it("uses the configured status topic and requires advancing source feedback after STOP", async () => {
    const { bridge } = mount(bridgeDouble(), { statusTopic: "/arm/status" }); await flush();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    const feedback = (topic: string, sec: number) => ({ op: "topic_message", topic, data: { header: { stamp: { sec, nanosec: 0 } }, mode: 3, fault_code: 0, last_command_sequence: 42 } });
    await act(async () => bridge.emit(feedback("/stm32/status", 2))); expect(screen.queryByText(/已确认输出关闭/)).not.toBeInTheDocument();
    await act(async () => bridge.emit(feedback("/arm/status", 2))); expect(screen.queryByText(/已确认输出关闭/)).not.toBeInTheDocument();
    await act(async () => bridge.emit(feedback("/arm/status", 3))); expect(screen.getByText(/已确认输出关闭/)).toBeVisible();
  });
  it("edits slider travel separately and retains seven rows", async () => {
    mount(); await flush(); expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-0.35"); expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("0.35");
    fireEvent.change(screen.getByLabelText("joint1 行程 min"), { target: { value: "-0.1" } }); fireEvent.change(screen.getByLabelText("joint1 行程 max"), { target: { value: "0.2" } });
    expect(screen.getByLabelText("joint1 Position 滑块")).toHaveAttribute("min", "-0.1"); expect(screen.getByLabelText("joint1 Position 滑块")).toHaveAttribute("max", "0.2");
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeDisabled(); select(); select(3); arm(); start(); await flush();
    expect(screen.getByLabelText("joint2 Position 滑块")).toBeDisabled();
  });
  it("never resumes late preflight after hiding/showing or unmounting", async () => {
    vi.useFakeTimers(); const bridge = bridgeDouble(); let complete!: (value: BridgeEnvelope) => void;
    bridge.command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { rerender, props, unmount } = mount(bridge); await flush(); select(); arm(); start();
    expect(props.onStreamingChange).toHaveBeenLastCalledWith(true);
    rerender(<MotorControl {...props} active={false} />); rerender(<MotorControl {...props} active />);
    await act(async () => complete({ op: "joint_command_ack", sequence: 43 })); await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(bridge.send).not.toHaveBeenCalled(); expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    expect(screen.getByLabelText("安全确认")).not.toBeChecked(); unmount();
  });
  it("requests DISABLE if the owner unmounts during preflight", async () => {
    const bridge = bridgeDouble(); let complete!: (value: BridgeEnvelope) => void; bridge.command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { unmount } = mount(bridge); await flush(); select(); arm(); start(); unmount();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 })); await act(async () => complete({ op: "joint_command_ack", sequence: 43 })); expect(bridge.send).not.toHaveBeenCalled();
  });
  it.each(["hidden", "locked"])("cancels a running timer when %s and retains the draft", async kind => {
    vi.useFakeTimers(); const { bridge, props, rerender } = mount(); await flush(); select(); fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.2" } }); arm(); start(); await flush();
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2);
    rerender(<MotorControl {...props} active={kind !== "hidden"} controlLocked={kind === "locked"} />); await flush(); await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(bridge.send).toHaveBeenCalledTimes(2); expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 })); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.2");
  });
});

describe("MotorControl V2", () => {
  it("restores the complete MIT group even when only one control axis is selected", async () => {
    const { bridge } = mount(bridgeDouble(capabilities({ control_modes: Array(7).fill("POS_VEL"), owner_source_id: "5" })));
    await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "应用驱动模式…" }));
    expect(screen.getByText(/恢复整组 MIT（7 轴）/)).toBeVisible();
    bridge.command.mockResolvedValueOnce({ op: "motor_set_control_mode_result", terminal: true, motor_control: capabilities({ control_epoch: 3, stamp_ns: "1100000000", operation_state: 2 }) });
    fireEvent.click(screen.getByLabelText("现场支撑确认")); fireEvent.click(screen.getByRole("button", { name: "确认应用驱动模式" })); await flush();
    expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: "motor_set_control_mode", control_mode: "MIT", active_joint_mask: 127 }));
    expect(screen.getByLabelText("joint1 选择控制")).toBeChecked(); expect(screen.getByLabelText("joint2 选择控制")).not.toBeChecked();
    expect(screen.getByText("实际驱动：MIT（已读回）")).toBeVisible();
  });
  it("does not acquire control or apply mode without verified output-off evidence", async () => {
    const { bridge } = mount(bridgeDouble(capabilities({ disabled_verified: false }))); await flush(); select();
    expect(screen.getByRole("button", { name: "应用驱动模式…" })).toBeDisabled(); arm(); start();
    expect(bridge.command).not.toHaveBeenCalled(); expect(screen.getByText(/请先停止并确认全部输出已关闭/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
  });
  it("separates candidate from actual mode and keeps independent blank POS drafts", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select();
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.6" } }); arm(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    expect(bridge.command).not.toHaveBeenCalled(); expect(screen.getByText("实际驱动：MIT（已读回）")).toBeVisible();
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue(""); expect(screen.getByLabelText("joint1 速度上限 · rad/s")).toHaveValue("");
    expect(screen.getByLabelText("安全确认")).not.toBeChecked(); expect(screen.getByLabelText("安全确认")).toBeDisabled();
    expect(screen.getByRole("button", { name: "执行目标并保持" })).toBeDisabled(); expect(screen.queryByLabelText("Kp")).not.toBeInTheDocument(); expect(screen.queryByRole("option", { name: "RETURN" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.3" } }); fireEvent.click(screen.getByRole("button", { name: "MIT" }));
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.6"); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" })); expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.3");
  });
  it("requires support confirmation and terminal verified readback before applying", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" })); fireEvent.click(screen.getByRole("button", { name: "应用驱动模式…" }));
    expect(screen.getByRole("button", { name: "确认应用驱动模式" })).toBeDisabled(); expect(screen.getByRole("button", { name: "停止并 DISABLE" })).not.toBeDisabled();
    let finish!: (value: BridgeEnvelope) => void; bridge.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByLabelText("现场支撑确认")); fireEvent.click(screen.getByRole("button", { name: "确认应用驱动模式" }));
    expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ op: "motor_set_control_mode", control_mode: "POS_VEL", active_joint_mask: 1, support_confirmation: "SUPPORTED" }));
    expect(screen.getByText("模式申请中")).toBeVisible();
    const next = capabilities({ control_modes: ["POS_VEL", ...Array(6).fill("MIT")], operation_state: 2, operation_id: 8, control_epoch: 3, stamp_ns: "1100000000" });
    await act(async () => finish({ op: "motor_set_control_mode_result", terminal: true, motor_control: next }));
    expect(screen.getByText("实际驱动：POS_VEL（已读回）")).toBeVisible(); expect(screen.getByLabelText("安全确认")).not.toBeChecked(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it("rejects an ACK without terminal readback and never auto-starts after partial configuration", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" })); fireEvent.click(screen.getByRole("button", { name: "应用驱动模式…" }));
    bridge.command.mockResolvedValueOnce({ op: "motor_set_control_mode_result", terminal: true, motor_control: capabilities({ verified_joint_mask: 126, operation_state: 3 }) });
    fireEvent.click(screen.getByLabelText("现场支撑确认")); fireEvent.click(screen.getByRole("button", { name: "确认应用驱动模式" })); await flush();
    expect(screen.getByText(/模式应用失败 \/ 结果未确认/)).toBeVisible(); expect(screen.getByRole("button", { name: "执行目标并保持" })).toBeDisabled(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it("acquires a fresh lease and continuously publishes only POS parameters, including HOLD", async () => {
    vi.useFakeTimers(); const current = capabilities({ control_modes: Array(7).fill("POS_VEL") }); const { bridge } = mount(bridgeDouble(current)); await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.3" } }); fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: "0.4" } });
    const leased = { ...current, owner_source_id: "5", lease_id: 9, selected_joint_mask: 1, stamp_ns: "1100000000" };
    bridge.command.mockResolvedValueOnce({ op: "motor_control_lease_ack", motor_control: leased }).mockResolvedValueOnce({ op: "motor_command_v2_ack", sequence: 42 }); arm(); start("执行目标并保持"); await flush();
    expect(bridge.command).toHaveBeenNthCalledWith(1, expect.objectContaining({ op: "motor_control_lease", lease_action: "acquire" }));
    expect(bridge.command).toHaveBeenNthCalledWith(2, { op: "motor_command_v2", boot_id: current.boot_id, control_epoch: 2, lease_id: 9, control_mode: "POS_VEL", mode: 1, active_joint_mask: 1, position: [0.3, 0, 0, 0, 0, 0, 0], pos_vel: { velocity_limit: [0.4, 0, 0, 0, 0, 0, 0] }, confirmation: "ARMED" });
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2); expect(screen.getByRole("button", { name: "持续控制中" })).toBeDisabled(); expect(screen.getByText("20 Hz · 固定参数快照")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...leased, last_command_sequence: 42, stamp_ns: "2000000000", enabled_joint_mask: 0, mode: 3, lease_id: 0, owner_source_id: "0" } }));
    expect(screen.getByText(/已确认输出关闭/)).toBeVisible(); fireEvent.change(screen.getByLabelText("执行状态"), { target: { value: "0" } }); expect(screen.getByRole("button", { name: "保持当前位置" })).toBeDisabled();
    bridge.command.mockResolvedValueOnce({ op: "motor_control_lease_ack", motor_control: { ...leased, lease_id: 10, stamp_ns: "2100000000" } }); arm(); start("保持当前位置"); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ op: "motor_command_v2", mode: 0, lease_id: 10, position: Array(7).fill(0) }));
  });
  it("cancels a pending lease when hidden and ignores its late grant", async () => {
    vi.useFakeTimers(); const current = capabilities({ control_modes: Array(7).fill("POS_VEL") }); const bridge = bridgeDouble(current); let finish!: (value: BridgeEnvelope) => void;
    bridge.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const { props, rerender } = mount(bridge); await flush(); select();
    fireEvent.click(screen.getByRole("button", { name: "POS_VEL" })); fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.3" } }); fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: "0.4" } }); arm(); start("执行目标并保持");
    rerender(<MotorControl {...props} active={false} />); rerender(<MotorControl {...props} active />);
    await act(async () => finish({ op: "motor_control_lease_ack", motor_control: { ...current, lease_id: 9, owner_source_id: "5" } })); await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(bridge.command.mock.calls.filter(([value]) => value.op === "motor_command_v2")).toHaveLength(0); expect(bridge.send).not.toHaveBeenCalled(); expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
  });
  it("fills speed limits only for selected axes and revokes confirmation", async () => {
    mount(bridgeDouble(capabilities({ control_modes: Array(7).fill("POS_VEL") }))); await flush(); select(); select(3); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    fireEvent.change(screen.getByLabelText("统一速度上限 · rad/s"), { target: { value: "0.25" } }); arm(); fireEvent.click(screen.getByRole("button", { name: "填写所选轴" }));
    expect(screen.getByLabelText("joint1 速度上限 · rad/s")).toHaveValue("0.25"); expect(screen.getByLabelText("joint3 速度上限 · rad/s")).toHaveValue("0.25"); expect(screen.getByLabelText("joint2 速度上限 · rad/s")).toHaveValue(""); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
  });
  it("rejects a stale V2 stop snapshot and requires advancing readback", async () => {
    const current = capabilities(); const { bridge } = mount(bridgeDouble(current)); await flush(); fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...current, last_command_sequence: 42 } })); expect(screen.queryByText(/已确认输出关闭/)).not.toBeInTheDocument();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...current, last_command_sequence: 42, stamp_ns: "2000000000" } })); expect(screen.getByText(/已确认输出关闭/)).toBeVisible();
  });
  it("revokes authorization on a firmware reboot and does not send on reconnect", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); arm();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities({ boot_id: "9" }) })); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    arm(); await act(async () => bridge.emit({ op: "disconnected" })); expect(screen.getByLabelText("安全确认")).not.toBeChecked(); expect(screen.getByRole("button", { name: "开始控制" })).toBeDisabled(); expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it("stops an existing MIT stream when firmware identity changes even if all modes remain MIT", async () => {
    vi.useFakeTimers(); const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); arm(); start(); await flush();
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2);
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities({ boot_id: "100", stamp_ns: "1" }) }));
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ op: "joint_command", mode: 3 }));
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
  });
  it("never downgrades to legacy MIT when V2 capability becomes unavailable", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); arm();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities({ supported: false, fresh: false, reason: "V2 状态丢失" }) }));
    expect(screen.getByLabelText("安全确认")).toBeDisabled(); expect(screen.getByRole("button", { name: "开始控制" })).toBeDisabled();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities() }));
    expect(screen.getByLabelText("安全确认")).toBeDisabled(); // Same source stamp cannot revive invalidated data.
    expect(bridge.command).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush(); expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ op: "joint_command", mode: 3 }));
  });
});
