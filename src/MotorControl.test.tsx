import { terminalOutput } from "./test/terminal";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotorControl } from "./MotorControl";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope, MotorControlCapabilities } from "./types";

const logging = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("./terminalLogLogic", async importOriginal => ({ ...await importOriginal<typeof import("./terminalLogLogic")>(), terminalPublish: logging.publish }));
beforeEach(() => logging.publish.mockClear());
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
function urdfJoint(name: string, lower: string | number = -1, upper: string | number = 1, type = "revolute", extra = "") {
  return `<link name="${name}_link"/><joint name="${name}" type="${type}"><parent link="base"/><child link="${name}_link"/><limit lower="${lower}" upper="${upper}" effort="1" velocity="2"/>${extra}</joint>`;
}
function motorUrdf(...joints: string[]) { return `<robot name="motor-test"><link name="base"/>${joints.join("")}</robot>`; }
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
    expect(screen.getByLabelText("Kp")).toBeDisabled(); expect(screen.getByLabelText("joint1 选择控制")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3, active_joint_mask: 0, position: [] }));
    expect(logging.publish).toHaveBeenCalledWith(expect.objectContaining({level: "warn", message: expect.stringContaining("原因：用户点击停止按钮")}));
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    expect(await terminalOutput("Motor")).toMatch(/已请求 DISABLE，停止确认中/);
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2);
    await act(async () => bridge.emit({ op: "topic_message", topic: "/stm32/status", data: { header: { stamp: { sec: 2, nanosec: 0 } }, mode: 3, fault_code: 0, last_command_sequence: 42 } }));
    expect(await terminalOutput("Motor")).toMatch(/已确认输出关闭/); expect(screen.getByRole("button", { name: "开始控制" })).toBeDisabled();
  });
  it("rejects empty selection and excessive effort, preserving unrestricted MIT numeric targets", async () => {
    const { bridge } = mount(bridgeDouble(), { urdfXml: motorUrdf(urdfJoint("joint1", -0.3, 0.3)) }); await flush(); arm(); start(); expect(screen.getByText("请至少选择一个关节")).toBeVisible(); expect(bridge.command).not.toHaveBeenCalled();
    select(); fireEvent.change(screen.getByLabelText("Effort · Nm"), { target: { value: "1.1" } }); arm(); start(); expect(screen.getByText("Effort 必须在 -1 到 1 之间")).toBeVisible(); expect(bridge.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Effort · Nm"), { target: { value: "1" } }); fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Velocity · rad/s"), { target: { value: "30" } }); fireEvent.change(screen.getByLabelText("Kp"), { target: { value: "80" } }); fireEvent.change(screen.getByLabelText("Kd"), { target: { value: "12" } }); arm(); start(); await flush();
    expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ position: [12, 0, 0, 0, 0, 0, 0], velocity: 30, kp: 80, kd: 12, effort: 1 }));
  });
  it("requests DISABLE after an ambiguous first-frame failure instead of assuming nothing was published", async () => {
    const bridge = bridgeDouble(); bridge.command.mockRejectedValueOnce(new Error("ACK timeout")); mount(bridge); await flush(); select(); arm(); start(); await flush();
    expect(bridge.command).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: 1 })); expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    expect(await terminalOutput("Motor")).toMatch(/控制未开始：Error: ACK timeout；已请求停止/); expect(bridge.send).not.toHaveBeenCalled(); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
  });
  it("uses the configured status topic and requires advancing source feedback after STOP", async () => {
    const { bridge } = mount(bridgeDouble(), { statusTopic: "/arm/status" }); await flush();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    const feedback = (topic: string, sec: number) => ({ op: "topic_message", topic, data: { header: { stamp: { sec, nanosec: 0 } }, mode: 3, fault_code: 0, last_command_sequence: 42 } });
    await act(async () => bridge.emit(feedback("/stm32/status", 2))); expect(await terminalOutput("Motor")).not.toMatch(/已确认输出关闭/);
    await act(async () => bridge.emit(feedback("/arm/status", 2))); expect(await terminalOutput("Motor")).not.toMatch(/已确认输出关闭/);
    await act(async () => bridge.emit(feedback("/arm/status", 3))); expect(await terminalOutput("Motor")).toMatch(/已确认输出关闭/);
  });
  it("shows read-only model bounds by joint name while preserving the seven command slots", async () => {
    const urdfXml = motorUrdf(urdfJoint("joint3", -2, 2), urdfJoint("joint1", -0.1, 0.2));
    mount(bridgeDouble(), { urdfXml }); await flush();
    expect(within(screen.getByRole("table", { name: "关节控制列表" })).getAllByRole("row").slice(1)).toHaveLength(7);
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-0.1");
    expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("0.2");
    expect(screen.getByLabelText("joint1 行程 min")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("joint1 行程 max")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("joint3 行程 min")).toHaveValue("-2");
    expect(screen.getByLabelText("joint2 行程 min")).toHaveValue("");
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeDisabled(); select();
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeEnabled();
    expect(screen.getByLabelText("joint1 Position 滑块")).toHaveAttribute("min", "-0.1");
    expect(screen.getByLabelText("joint1 Position 滑块")).toHaveAttribute("max", "0.2");
    select(2); expect(screen.getByLabelText("joint2 Position 滑块")).toBeDisabled();
    expect(screen.getByLabelText("joint2 Position · rad")).toBeEnabled();
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
    expect(logging.publish).toHaveBeenCalledWith(expect.objectContaining({message: expect.stringContaining(kind === "hidden" ? "原因：页面不再活动" : "原因：其他控制任务占用")}));
  });
});

describe("MotorControl live model ranges", () => {
  it.each([
    ["not loaded", ""],
    ["missing joint", motorUrdf(urdfJoint("other_joint"))],
    ["continuous joint", motorUrdf(urdfJoint("joint1", -1, 1, "continuous"))],
    ["fixed joint", motorUrdf(urdfJoint("joint1", -1, 1, "fixed"))],
    ["mimic joint", motorUrdf(urdfJoint("joint1", -1, 1, "revolute", '<mimic joint="joint2"/>'))],
    ["unmapped prismatic joint", motorUrdf(urdfJoint("joint1", 0, 0.05, "prismatic"))],
    ["missing limits", motorUrdf('<link name="tip"/><joint name="joint1" type="revolute"><parent link="base"/><child link="tip"/></joint>')],
    ["infinite limits", motorUrdf(urdfJoint("joint1", "-Infinity", "Infinity"))],
    ["reversed limits", motorUrdf(urdfJoint("joint1", 1, -1))],
    ["invalid XML", "<robot><joint"],
  ])("disables only the slider for %s without inventing a range", async (_reason, urdfXml) => {
    const { bridge } = mount(bridgeDouble(), { urdfXml }); await flush(); select();
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("");
    expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("");
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeDisabled();
    expect(screen.getByLabelText("joint1 Position · rad")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "12" } });
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("12");
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });

  it("adopts a late model without changing the selected target or starting control", async () => {
    const { bridge, props, rerender } = mount(); await flush(); select();
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.6" } });
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeDisabled();
    rerender(<MotorControl {...props} urdfXml={motorUrdf(urdfJoint("joint1", -0.1, 0.2))} />); await flush();
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeEnabled();
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-0.1");
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.6");
    expect(screen.getByLabelText("joint1 选择控制")).toBeChecked();
    expect(screen.getByLabelText("joint2 选择控制")).not.toBeChecked();
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });

  it("shows calibrated raw joint7 radians and never copies a prismatic metre limit into Motor", async () => {
    const name = "gripper_finger_left_joint";
    const jointState = { name: [...Array.from({ length: 6 }, (_, index) => `joint${index + 1}`), name], position: [0, 0, 0, 0, 0, 0, 0.5] };
    const gripper = urdfJoint(name, 0, 0.0715, "prismatic");
    const calibration = `<ros2_control name="arm" type="system"><hardware>
      <plugin>microros_stm32h723_bridge/MicroRosSystem</plugin>
      <param name="gripper_position_scale">-0.008612826752</param>
      <param name="gripper_position_offset">0.004282757541</param>
      </hardware><joint name="${name}"><command_interface name="position">
      <param name="min">0</param><param name="max">0.05</param>
      </command_interface></joint></ros2_control>`;
    const { props, rerender, bridge } = mount(bridgeDouble(), { jointState, urdfXml: motorUrdf(gripper) }); await flush();
    fireEvent.click(screen.getByLabelText(`${name} 选择控制`));
    expect(screen.getByLabelText(`${name} 行程 min`)).toHaveValue("");
    expect(screen.getByLabelText(`${name} Position 滑块`)).toBeDisabled();
    rerender(<MotorControl {...props} urdfXml={motorUrdf(gripper, calibration)} />); await flush();
    const min = screen.getByLabelText<HTMLInputElement>(`${name} 行程 min`);
    const max = screen.getByLabelText<HTMLInputElement>(`${name} 行程 max`);
    expect(Number(min.value)).toBeCloseTo(-5.308041573, 6);
    expect(Number(max.value)).toBeCloseTo(0.497253418, 6);
    expect(min).toHaveAttribute("readonly"); expect(max).toHaveAttribute("readonly");
    const slider = screen.getByLabelText<HTMLInputElement>(`${name} Position 滑块`);
    expect(slider).toBeEnabled(); expect(slider).toHaveAttribute("step", "any");
    expect(Number(slider.min)).toBeCloseTo((0.05 - 0.004282757541) / -0.008612826752, 12);
    expect(Number(slider.max)).toBeCloseTo((0 - 0.004282757541) / -0.008612826752, 12);
    expect(screen.getByLabelText(`${name} Position · rad`)).toHaveValue("0");
    expect(screen.getByLabelText("gripper_finger_left_joint 实测位置")).toBeVisible();
    expect(screen.getByLabelText("gripper_finger_left_joint 实测位置")).toHaveTextContent("0.5000");
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });

  it("shares updated ranges between MIT and POS while preserving their independent target drafts", async () => {
    const { bridge, props, rerender } = mount(bridgeDouble(capabilities()), { urdfXml: motorUrdf(urdfJoint("joint1", -1, 1)) }); await flush(); select();
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.6" } });
    fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-1");
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: "0.2" } });
    rerender(<MotorControl {...props} urdfXml={motorUrdf(urdfJoint("joint1", -0.1, 0.1))} />); await flush();
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-0.1");
    expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("0.1");
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.3");
    expect(screen.getByLabelText("joint1 速度上限 · rad/s")).toHaveValue("0.2");
    fireEvent.click(screen.getByRole("button", { name: "MIT" }));
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("-0.1");
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.6");
    expect(screen.getByLabelText("joint1 选择控制")).toBeChecked();
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });

  it("drops old model limits when the live model or feedback joint name changes", async () => {
    const urdfXml = motorUrdf(urdfJoint("joint1", -1, 1));
    const { props, rerender } = mount(bridgeDouble(), { urdfXml }); await flush(); select();
    rerender(<MotorControl {...props} jointState={{ name: ["replacement_joint"], position: [0.15] }} />); await flush();
    expect(screen.getByLabelText("replacement_joint 行程 min")).toHaveValue("");
    expect(screen.getByLabelText("replacement_joint Position 滑块")).toBeDisabled();
    rerender(<MotorControl {...props} urdfXml={motorUrdf(urdfJoint("replacement_joint", -2, 2))} />); await flush();
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("");
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeDisabled();
    rerender(<MotorControl {...props} urdfXml="" />); await flush();
    expect(screen.getByLabelText("joint1 行程 min")).toHaveValue("");
    expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("");
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeDisabled();
  });

  it("keeps an already approved MIT payload unchanged when model bounds refresh", async () => {
    vi.useFakeTimers();
    const { bridge, props, rerender } = mount(bridgeDouble(), { urdfXml: motorUrdf(urdfJoint("joint1", -1, 1)) }); await flush(); select();
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.6" } }); arm(); start(); await flush();
    rerender(<MotorControl {...props} urdfXml={motorUrdf(urdfJoint("joint1", -0.1, 0.1))} />); await flush();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.6");
    expect(bridge.command).toHaveBeenCalledTimes(1);
    expect(bridge.send).toHaveBeenCalledTimes(2);
    for (const [payload] of bridge.send.mock.calls) expect(payload).toMatchObject({ mode: 1, active_joint_mask: 1, position: [0.6, 0, 0, 0, 0, 0, 0] });
  });

  it("still rejects a POS target outside firmware capability even inside the model slider range", async () => {
    const current = capabilities({ control_modes: Array(7).fill("POS_VEL"), position_min: Array(7).fill(-1), position_max: Array(7).fill(1) });
    const { bridge } = mount(bridgeDouble(current), { urdfXml: motorUrdf(urdfJoint("joint1", -3, 3)) }); await flush(); select();
    fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    expect(screen.getByLabelText("joint1 行程 max")).toHaveValue("3");
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: "0.2" } }); arm(); start("执行目标并保持"); await flush();
    expect(await terminalOutput("Motor")).toMatch(/joint1 Position 超过已验证范围/);
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
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
    expect(bridge.command).not.toHaveBeenCalled(); expect(await terminalOutput("Motor")).toMatch(/请先停止并确认全部输出已关闭/);
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
    expect(logging.publish).toHaveBeenCalledWith(expect.objectContaining({source:"Motor",message:expect.stringContaining("应用成功：POS_VEL 已读回")}));
    expect(screen.getByText("实际驱动：POS_VEL（已读回）")).toBeVisible(); expect(screen.getByLabelText("安全确认")).not.toBeChecked(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it("rejects an ACK without terminal readback and never auto-starts after partial configuration", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" })); fireEvent.click(screen.getByRole("button", { name: "应用驱动模式…" }));
    bridge.command.mockResolvedValueOnce({ op: "motor_set_control_mode_result", terminal: true, motor_control: capabilities({ verified_joint_mask: 126, operation_state: 3 }) });
    fireEvent.click(screen.getByLabelText("现场支撑确认")); fireEvent.click(screen.getByRole("button", { name: "确认应用驱动模式" })); await flush();
    expect(await terminalOutput("Motor")).toMatch(/模式应用失败 \/ 结果未确认/); expect(screen.getByRole("button", { name: "执行目标并保持" })).toBeDisabled(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it("acquires a fresh lease and continuously publishes only POS parameters, including HOLD", async () => {
    vi.useFakeTimers(); const current = capabilities({ control_modes: Array(7).fill("POS_VEL") }); const { bridge } = mount(bridgeDouble(current)); await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.3" } }); fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: "0.4" } });
    const leased = { ...current, owner_source_id: "5", lease_id: 9, selected_joint_mask: 1, stamp_ns: "1100000000" };
    bridge.command.mockResolvedValueOnce({ op: "motor_control_lease_ack", motor_control: leased }).mockResolvedValueOnce({ op: "motor_command_v2_ack", sequence: 42 }); arm(); start("执行目标并保持"); await flush();
    expect(bridge.command).toHaveBeenNthCalledWith(1, expect.objectContaining({ op: "motor_control_lease", lease_action: "acquire" }));
    expect(bridge.command).toHaveBeenNthCalledWith(2, { op: "motor_command_v2", boot_id: current.boot_id, control_epoch: 2, lease_id: 9, control_mode: "POS_VEL", mode: 1, active_joint_mask: 1, position: [0.3, 0, 0, 0, 0, 0, 0], pos_vel: { velocity_limit: [0.4, 0, 0, 0, 0, 0, 0] }, confirmation: "ARMED" });
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).toHaveBeenCalledTimes(2); expect(screen.getByRole("button", { name: "更新目标并保持" })).toBeDisabled(); expect(screen.getByText("页面确认 20 Hz · 安装版原生续发 50 Hz · 最近提交目标")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...leased, last_command_sequence: 42, stamp_ns: "2000000000", enabled_joint_mask: 0, mode: 3, lease_id: 0, owner_source_id: "0" } }));
    expect(await terminalOutput("Motor")).toMatch(/已确认输出关闭/); fireEvent.change(screen.getByLabelText("执行状态"), { target: { value: "0" } }); expect(screen.getByRole("button", { name: "保持当前位置" })).toBeDisabled();
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
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...current, last_command_sequence: 42 } })); expect(await terminalOutput("Motor")).not.toMatch(/已确认输出关闭/);
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...current, last_command_sequence: 42, stamp_ns: "2000000000" } })); expect(await terminalOutput("Motor")).toMatch(/已确认输出关闭/);
  });
  it("revokes authorization on a firmware reboot and does not send on reconnect", async () => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); arm();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities({ boot_id: "9" }) })); expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    arm(); await act(async () => bridge.emit({ op: "disconnected" })); expect(screen.getByLabelText("安全确认")).not.toBeChecked(); expect(screen.getByRole("button", { name: "开始控制" })).toBeDisabled(); expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it.each([false, true])("unlocks reconnect only with new verified output-off evidence (reboot=%s)", async reboot => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush(); select(); arm();
    await act(async () => bridge.emit({ op: "disconnected" }));
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities() }));
    expect(screen.getByRole("button", { name: "POS_VEL" })).toBeDisabled(); // Replayed stamp cannot unlock.
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities({ boot_id: reboot ? "99" : "9007199254740993", stamp_ns: "2000000000" }) }));
    expect(screen.getByRole("button", { name: "POS_VEL" })).not.toBeDisabled();
    expect(await terminalOutput("Motor")).toMatch(/已确认输出关闭/);
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
  });
  it.each([{ disabled_verified: false }, { fresh: false }, { mode: 1 }, { enabled_joint_mask: 1 }, { lease_id: 2 }, { owner_source_id: "5" }, { switching: true }, { fault_code: 1 }])("keeps reconnect locked for incomplete output-off proof %j", async patch => {
    const { bridge } = mount(bridgeDouble(capabilities())); await flush();
    await act(async () => bridge.emit({ op: "disconnected" }));
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: capabilities({ stamp_ns: "2000000000", ...patch }) }));
    expect(screen.getByRole("button", { name: "POS_VEL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止并 DISABLE" })).not.toBeDisabled();
    expect(bridge.command).not.toHaveBeenCalled(); expect(bridge.send).not.toHaveBeenCalled();
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


describe("Motor mode history", () => {
  it("retains joint7 failure across stop proof, polling and reopening confirmation", async () => {
    const initial = capabilities({ pos_vel_supported_mask: 64 });
    const bridge = bridgeDouble(initial);
    mount(bridge, { jointState: { name: ["joint1", "joint2", "joint3", "joint4", "joint5", "joint6", "gripper_finger_left_joint"], position: [0, 0, 0, 0, 0, 0, 0.511749] } }); await flush();
    fireEvent.click(screen.getByLabelText("gripper_finger_left_joint 选择控制"));
    fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    fireEvent.click(screen.getByRole("button", { name: "应用驱动模式…" }));
    let reject!: (reason: Error) => void;
    bridge.command.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    fireEvent.click(screen.getByLabelText("现场支撑确认"));
    fireEvent.click(screen.getByRole("button", { name: "确认应用驱动模式" }));
    expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ active_joint_mask: 64, control_mode: "POS_VEL" }));
    const failed = capabilities({ pos_vel_supported_mask: 64, operation_id: 4, selected_joint_mask: 64, operation_state: 3, error_code: 10, stamp_ns: "2000000000", position_max: [0, 0, 0, 0, 0, 0, 0.508316] });
    await act(async () => {
      bridge.emit({ op: "motor_control_status", motor_control: failed });
      reject(new Error("固件模式操作失败或已取消"));
    });
    const stopped = { ...failed, stamp_ns: "3000000000", last_command_sequence: 42 };
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: stopped }));
    const log = () => logging.publish.mock.calls.map(([entry])=>entry.message).join("\n");
    expect(log()).toContain("joint7（gripper_finger_left_joint）");
    expect(log()).toContain("mask=64");
    expect(log()).toContain("error=10（超出固件已验证范围）");
    expect(log()).toContain("joint7 0.511749 rad");
    expect(await terminalOutput("Motor")).toContain("应用失败 / 结果未确认");
    expect(log()).toContain("停止反馈：已核验输出关闭");
    expect(screen.queryByText(/固件模式事务 #4 失败/)).toBeNull();
    expect(screen.queryByText("固件已验证范围")).toBeNull();
    expect(screen.getByLabelText("gripper_finger_left_joint 行程 min")).toBeVisible();
    const lines = logging.publish.mock.calls.length;
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...stopped, stamp_ns: "4000000000" } }));
    expect(logging.publish).toHaveBeenCalledTimes(lines);
    // Stale success must not replace the accepted failure or pollute history.
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...failed, operation_state: 2, error_code: 0 } }));
    expect(logging.publish).toHaveBeenCalledTimes(lines);
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...stopped, stamp_ns: "5000000000" } }));
    fireEvent.click(screen.getByRole("button", { name: "应用驱动模式…" }));
    expect(await terminalOutput("Motor")).toContain("应用失败 / 结果未确认");
    expect(bridge.command).toHaveBeenCalledTimes(2); // configure, then DISABLE only
    expect(bridge.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", {name:"查看操作日志"})).toBeEnabled();
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.queryByText(/固件模式事务 #4 失败/)).toBeNull();
  });
  it("retains rapid observed pending/failure transitions, and retains unified history on disconnect", async () => {
    const bridge = bridgeDouble(capabilities()); mount(bridge); await flush();
    await act(async () => {
      bridge.emit({ op: "motor_control_status", motor_control: capabilities({ operation_id: 1, operation_state: 1, stamp_ns: "2000000000" }) });
      bridge.emit({ op: "motor_control_status", motor_control: capabilities({ operation_id: 1, operation_state: 3, error_code: 13, stamp_ns: "3000000000" }) });
    });
    const log = () => logging.publish.mock.calls.map(([entry])=>entry.message).join("\n");
    expect(log()).toContain("进行中"); expect(log()).toContain("寄存器操作超时");
    expect(logging.publish).toHaveBeenCalledTimes(2);
    await act(async () => bridge.emit({ op: "disconnected" }));
    expect(log()).toContain("进行中"); expect(log()).toContain("寄存器操作超时");
    expect(bridge.command).not.toHaveBeenCalled();
  });
});

describe("Motor continuous retargeting", () => {
  async function runningPos() {
    const initial = capabilities({ control_modes: Array(7).fill("POS_VEL") });
    const mounted = mount(bridgeDouble(initial), { urdfXml: motorUrdf(urdfJoint("joint1", -3, 3)) });
    await flush(); select(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value: "0.3" } });
    fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: "0.4" } });
    const leased = { ...initial, owner_source_id: "5", lease_id: 9, selected_joint_mask: 1, stamp_ns: "1100000000" };
    mounted.bridge.command.mockResolvedValueOnce({ op: "motor_control_lease_ack", motor_control: leased });
    arm(); start("执行目标并保持"); await flush();
    const running = { ...leased, disabled_verified: false, mode: 1, enabled_joint_mask: 1, stamp_ns: "1200000000" };
    mounted.bridge.setCapabilities(running);
    await act(async () => mounted.bridge.emit({ op: "motor_control_status", motor_control: running }));
    return { ...mounted, running };
  }
  function target(value: string) { fireEvent.change(screen.getByLabelText("joint1 Position · rad"), { target: { value } }); }
  function update() { start("更新目标并保持"); }

  it("keeps streaming through a delayed query but stops when the newer evidence expires", async () => {
    vi.useFakeTimers(); const { bridge, running } = await runningPos();
    const older = { ...running, stamp_ns: "1150000000" };
    bridge.setCapabilities(older);
    await act(async () => bridge.emit({ op: "motor_capabilities", motor_control: older }));
    await act(async () => vi.advanceTimersByTime(600));
    expect(bridge.send).toHaveBeenCalledWith(expect.objectContaining({ op: "motor_command_v2", mode: 1 }));
    expect(bridge.command.mock.calls.some(([m]) => m.mode === 3)).toBe(false);
    // Polling older evidence cannot keep the source fresh forever.
    await act(async () => vi.advanceTimersByTime(2000));
    expect(bridge.command.mock.calls.some(([m]) => m.mode === 3)).toBe(true);
  });

  it.each([
    ["older push", { stamp_ns: "1150000000" }, "源时间戳回退"],
    ["lease loss", { stamp_ns: "1300000000", lease_id: 0 }, "控制租约变更或已失效"],
    ["fault", { stamp_ns: "1300000000", fault_code: 2 }, "固件故障 2"],
  ])("records the specific %s stop and pre-stop lease evidence", async (_name, patch, reason) => {
    vi.useFakeTimers(); const { bridge, running } = await runningPos();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...running, ...patch } }));
    await act(async () => vi.advanceTimersByTime(50));
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    const entry = logging.publish.mock.calls.map(([entry]) => entry.message).find(message => message.startsWith("请求 DISABLE · 原因："));
    expect(entry).toContain(reason); expect(entry).toContain("/9；owner=5；source=5");
    if (_name === "older push") expect(entry).toContain("stamp=1150000000，watermark=1200000000");
  });

  it("edits a draft while holding, then repeatedly updates the same lease without DISABLE", async () => {
    vi.useFakeTimers(); const { bridge, props } = await runningPos();
    expect(screen.getByLabelText("joint1 Position · rad")).toBeEnabled();
    expect(screen.getByLabelText("joint1 Position 滑块")).toBeEnabled();
    expect(screen.getByLabelText("joint1 速度上限 · rad/s")).toBeEnabled();
    expect(screen.getByLabelText("joint2 Position · rad")).toBeDisabled();
    expect(screen.getByLabelText("joint1 选择控制")).toBeEnabled();
    expect(screen.getByLabelText("执行状态")).toBeDisabled();
    expect(screen.getByRole("button", { name: "MIT" })).toBeDisabled();
    for (const value of ["0.6", "-0.5", "0.2"]) {
      const previous = bridge.command.mock.calls.at(-1)![0];
      target(value);
      expect(screen.getByLabelText("安全确认")).not.toBeChecked();
      expect(screen.getByRole("button", { name: "更新目标并保持" })).toBeDisabled();
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(bridge.send).toHaveBeenLastCalledWith(previous);
      arm(); update(); await flush();
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(bridge.send).toHaveBeenLastCalledWith(expect.objectContaining({ lease_id: 9, control_epoch: 2, active_joint_mask: 1, position: [Number(value), 0, 0, 0, 0, 0, 0] }));
      expect(screen.getByRole("button", { name: "更新目标并保持" })).toBeDisabled();
    }
    expect(bridge.command.mock.calls.filter(([p]) => p.op === "motor_control_lease")).toHaveLength(1);
    expect(bridge.command.mock.calls.some(([p]) => p.mode === 3)).toBe(false);
    expect(props.onStreamingChange).not.toHaveBeenCalledWith(false);
  });

  it.each([["", "0.4"], ["4", "0.4"], ["0.5", "0"], ["0.5", "3"]])("keeps the applied target on invalid draft position=%s speed=%s", async (position, speed) => {
    vi.useFakeTimers(); const { bridge } = await runningPos();
    target(position); fireEvent.change(screen.getByLabelText("joint1 速度上限 · rad/s"), { target: { value: speed } });
    arm(); update(); await flush();
    expect(screen.getByRole("alert")).toBeVisible();
    expect(bridge.command).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(bridge.send).toHaveBeenLastCalledWith(expect.objectContaining({ position: [0.3, 0, 0, 0, 0, 0, 0], pos_vel: { velocity_limit: [0.4, 0, 0, 0, 0, 0, 0] } }));
  });

  it("selects a second axis with a different mode without changing or stopping the applied stream", async () => {
    vi.useFakeTimers(); const { bridge, running } = await runningPos();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...running, stamp_ns: "1300000000", control_modes: ["POS_VEL", ...Array(6).fill("MIT")] } }));
    expect(screen.getByLabelText("joint2 选择控制")).toBeEnabled();
    select(2);
    expect(screen.getByLabelText("joint2 选择控制")).toBeChecked();
    expect(screen.getByLabelText("joint2 Position · rad")).toBeEnabled();
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "更新目标并保持" })).toBeDisabled();
    expect(screen.getByText(/选轴草稿已更改，当前控制保持不变/)).toBeVisible();
    expect(screen.getByText(/持续控制中 · POS_VEL \/ TRACK · 1 轴 · 待应用选轴 2 轴/)).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(bridge.command).toHaveBeenCalledTimes(2);
    expect(bridge.send).toHaveBeenLastCalledWith(expect.objectContaining({ active_joint_mask: 1, lease_id: 9, position: [0.3, 0, 0, 0, 0, 0, 0] }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前选轴" }));
    expect(screen.getByLabelText("joint2 选择控制")).not.toBeChecked();
    target("0.5"); arm(); update(); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ active_joint_mask: 1, position: [0.5, 0, 0, 0, 0, 0, 0] }));
  });

  it("selects and clears all draft axes while keeping the one-axis stream alive", async () => {
    vi.useFakeTimers(); const { bridge } = await runningPos();
    fireEvent.click(screen.getByRole("checkbox", { name: "全选轴" }));
    for (let i = 1; i <= 7; i++) expect(screen.getByLabelText(`joint${i} 选择控制`)).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "全选轴" })).toBeChecked();
    expect(screen.getByText("已选 7/7")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "全选轴" }));
    expect(screen.getByText("已选 0/7")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "全选轴" })).not.toBeChecked();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(bridge.command).toHaveBeenCalledTimes(2);
    expect(bridge.send).toHaveBeenLastCalledWith(expect.objectContaining({ active_joint_mask: 1 }));
  });

  it("retains the new axis draft through an explicit stop and requires a new lease to execute it", async () => {
    const { bridge, running } = await runningPos();
    select(2);
    fireEvent.change(screen.getByLabelText("joint2 Position · rad"), { target: { value: "0.2" } });
    fireEvent.change(screen.getByLabelText("joint2 速度上限 · rad/s"), { target: { value: "0.3" } });
    fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" })); await flush();
    expect(screen.getByLabelText("joint2 选择控制")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "全选轴" })).toBeDisabled();
    const stopped = { ...running, stamp_ns: "1400000000", disabled_verified: true, mode: 3, enabled_joint_mask: 0, lease_id: 0, owner_source_id: "0", last_command_sequence: 42 };
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: stopped }));
    expect(screen.getByLabelText("joint2 选择控制")).toBeChecked();
    expect(screen.getByLabelText("joint2 Position · rad")).toHaveValue("0.2");
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    bridge.command.mockResolvedValueOnce({ op: "motor_control_lease_ack", motor_control: { ...stopped, stamp_ns: "1500000000", lease_id: 10, owner_source_id: "5", selected_joint_mask: 3 } });
    arm(); start("执行目标并保持"); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ active_joint_mask: 3, lease_id: 10, position: [0.3, 0.2, 0, 0, 0, 0, 0] }));
  });

  it("does not bypass unsupported-axis validation when selecting all POS_VEL axes", async () => {
    const { bridge } = mount(bridgeDouble(capabilities({ control_modes: Array(7).fill("POS_VEL"), pos_vel_supported_mask: 63 })));
    await flush(); fireEvent.click(screen.getByRole("button", { name: "POS_VEL" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全选轴" }));
    expect(screen.getByText("已选 7/7")).toBeVisible();
    expect(screen.getByLabelText("安全确认")).toBeDisabled();
    expect(screen.getByRole("button", { name: "执行目标并保持" })).toBeDisabled();
    expect(bridge.command).not.toHaveBeenCalled();
  });

  it.each([{ active: false }, { controlLocked: true }])("locks single and batch selection when unavailable: %j", async extra => {
    mount(bridgeDouble(), extra); await flush();
    expect(screen.getByLabelText("joint1 选择控制")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "全选轴" })).toBeDisabled();
  });

  it("atomically replaces the interval snapshot while an update ACK is delayed", async () => {
    vi.useFakeTimers(); const { bridge } = await runningPos(); let complete!: (value: BridgeEnvelope) => void;
    target("0.8"); fireEvent.change(screen.getByLabelText("统一速度上限 · rad/s"), { target: { value: "0.2" } });
    fireEvent.click(screen.getByRole("button", { name: "填写所选轴" }));
    bridge.command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    arm(); update();
    expect(screen.getByRole("button", { name: "正在更新…" })).toBeDisabled();
    expect(screen.getByLabelText("joint1 Position · rad")).toBeDisabled();
    expect(screen.getByLabelText("joint2 选择控制")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "全选轴" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停止并 DISABLE" })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    expect(bridge.send).toHaveBeenCalledTimes(3);
    for (const [p] of bridge.send.mock.calls) expect(p).toMatchObject({ position: [0.8, 0, 0, 0, 0, 0, 0], pos_vel: { velocity_limit: [0.2, 0, 0, 0, 0, 0, 0] }, lease_id: 9 });
    await act(async () => complete({ op: "motor_command_v2_ack", sequence: 43 }));
    expect(screen.getByLabelText("joint1 Position · rad")).toBeEnabled();
  });

  it.each(["stop", "hidden", "unmount", "disconnect"])("never resumes an update after %s, even with a late ACK", async action => {
    vi.useFakeTimers(); const { bridge, props, rerender, unmount } = await runningPos(); let complete!: (value: BridgeEnvelope) => void;
    target("0.8"); bridge.command.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })); arm(); update();
    if (action === "stop") fireEvent.click(screen.getByRole("button", { name: "停止并 DISABLE" }));
    else if (action === "hidden") { rerender(<MotorControl {...props} active={false} />); rerender(<MotorControl {...props} active />); }
    else if (action === "unmount") unmount();
    else await act(async () => bridge.emit({ op: "disconnected" }));
    await flush(); const commandsAfterStop = bridge.command.mock.calls.length;
    await act(async () => complete({ op: "motor_command_v2_ack", sequence: 43 }));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(bridge.send).not.toHaveBeenCalled(); expect(bridge.command).toHaveBeenCalledTimes(commandsAfterStop);
    if (action !== "disconnect") expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
  });

  it.each([{ lease_id: 10 }, { owner_source_id: "6" }, { boot_id: "100" }, { control_epoch: 3 }, { fresh: false }, { fault_code: 1 }])("does not apply a draft after control evidence changes: %j", async patch => {
    vi.useFakeTimers(); const { bridge, running } = await runningPos(); target("0.8"); arm();
    await act(async () => bridge.emit({ op: "motor_control_status", motor_control: { ...running, stamp_ns: "1300000000", ...patch } }));
    update(); await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(bridge.command.mock.calls.filter(([p]) => p.op === "motor_command_v2")).toHaveLength(1);
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    expect(bridge.send).not.toHaveBeenCalled();
  });

  it("stops on an ambiguous update failure instead of silently reverting a possibly applied target", async () => {
    vi.useFakeTimers(); const { bridge } = await runningPos(); target("0.8");
    bridge.command.mockRejectedValueOnce(new Error("ACK timeout")); arm(); update(); await flush();
    expect(bridge.command).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 3 }));
    await act(async () => vi.advanceTimersByTimeAsync(100)); expect(bridge.send).not.toHaveBeenCalled();
    expect(await terminalOutput("Motor")).toContain("目标更新结果未确认");
  });

  it("updates MIT position and velocity without changing gains, mask or restarting the stream", async () => {
    vi.useFakeTimers(); const { bridge } = mount(); await flush(); select(); arm(); start(); await flush();
    target("0.7"); fireEvent.change(screen.getByLabelText("Velocity · rad/s"), { target: { value: "0.1" } });
    expect(screen.getByLabelText("Kp")).toBeDisabled(); expect(screen.getByLabelText("Kd")).toBeDisabled(); expect(screen.getByLabelText("Effort · Nm")).toBeDisabled();
    arm(); update(); await flush(); await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(bridge.command).toHaveBeenCalledTimes(2); expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(bridge.send).toHaveBeenLastCalledWith(expect.objectContaining({ op: "joint_command", mode: 1, position: [0.7, 0, 0, 0, 0, 0, 0], velocity: 0.1, kp: 8, kd: 2, active_joint_mask: 1 }));
  });
});


describe("Motor unified joint table", () => {
  it("shows seven aligned rows and a mixed-state select-all checkbox without submitting commands", async () => {
    const { bridge } = mount(); await flush();
    const table = screen.getByRole("table", { name: "关节控制列表" });
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(within(table).getAllByRole("rowheader").map(row => row.textContent)).toEqual(Array.from({length: 7}, (_, i) => `joint${i + 1}`));
    const all = screen.getByRole("checkbox", { name: "全选轴" });
    select(); expect(all).toBePartiallyChecked();
    fireEvent.click(all); expect(all).toBeChecked(); expect(all).not.toBePartiallyChecked();
    select(2); expect(all).toBePartiallyChecked();
    fireEvent.click(all); fireEvent.click(all); expect(all).not.toBeChecked(); expect(all).not.toBePartiallyChecked();
    expect(screen.getByRole("button", { name: "使用当前位置" })).toBeDisabled();
    expect(bridge.command).not.toHaveBeenCalled();
  });

  it("copies current positions only into selected rows and never replaces a draft on feedback updates", async () => {
    const { bridge, props, rerender } = mount(); await flush();
    select(2); fireEvent.change(screen.getByLabelText("joint2 Position · rad"), {target: {value: "0.8"}}); select(2);
    select(); arm(); fireEvent.click(screen.getByRole("button", { name: "使用当前位置" }));
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.15");
    expect(screen.getByLabelText("joint2 Position · rad")).toHaveValue("0.8");
    expect(screen.getByLabelText("安全确认")).not.toBeChecked();
    rerender(<MotorControl {...props} jointState={{name: ["joint1", "joint2", "joint3"], position: [0.4, 0.5, 0.6]}} />);
    expect(screen.getByLabelText("joint1 实测位置")).toHaveTextContent("0.4000");
    expect(screen.getByLabelText("joint1 Position · rad")).toHaveValue("0.15");
    expect(screen.getByLabelText("joint2 Position · rad")).toHaveValue("0.8");
    expect(bridge.command).not.toHaveBeenCalled();
  });

  it("switches only the mode-specific columns and fills speed only on selected axes", async () => {
    const { bridge } = mount(bridgeDouble(capabilities({pos_vel_supported_mask: 127}))); await flush();
    expect(screen.queryByRole("columnheader", {name: /速度上限/})).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Kp")).toHaveLength(1);
    select(); fireEvent.click(screen.getByRole("button", {name: "POS_VEL"}));
    expect(screen.getByRole("columnheader", {name: /速度上限/})).toBeVisible();
    expect(screen.queryByLabelText("Kp")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("统一速度上限 · rad/s"), {target: {value: "0.3"}});
    fireEvent.click(screen.getByRole("button", {name: "填写所选轴"}));
    expect(screen.getByLabelText("joint1 速度上限 · rad/s")).toHaveValue("0.3");
    expect(screen.getByLabelText("joint2 速度上限 · rad/s")).toHaveValue("");
    expect(bridge.command).not.toHaveBeenCalled();
  });
});
