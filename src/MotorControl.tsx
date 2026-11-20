import { ActionButton } from "./ActionButton";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { BridgeEnvelope, HardwareStatus, MotorControlCapabilities } from "./types";
import { createCommandPayload, createDefaultMotors, DEFAULT_JOINT_COUNT, DEFAULT_KD, DEFAULT_KP, DEFAULT_MODE, faultInfo, jointLabel, modes, normalizeDecimal, parseCommandValues, resizeMotors } from "./motorLogic";
import { motorRangeFor, parseMotorUrdfRanges } from "./motorRangeLogic";
import type { CommandMode, MotorRowInput } from "./motorLogic";
import { actualDriveMode, acceptMotorEvidence, controlGate, type MotorEvidenceWatermark, createPosVelPayload, hasStopProof, parsePosVelValues, selectedMotorMask } from "./motorControlLogic";

import { appendMotorModeLog, formatMotorNumber, motorAxisNames, motorFirmwareRanges, motorModeEvidence, motorModeFailure, type MotorModeLogEntry } from "./motorModeLogLogic";

type JointState = { name?: string[]; position?: number[]; velocity?: number[]; effort?: number[] };
type Pending = "starting" | "configuring" | "stopping" | null;
function blankPosMotors(): MotorRowInput[] { return createDefaultMotors().map(row => ({ ...row, position: "" })); }
function sourceStamp(value: unknown): bigint | null {
  const data = value as { header?: { stamp?: { sec?: unknown; nanosec?: unknown } } } | undefined;
  const stamp = data?.header?.stamp;
  if (!Number.isSafeInteger(stamp?.sec) || !Number.isSafeInteger(stamp?.nanosec)) return null;
  return BigInt(stamp!.sec as number) * 1_000_000_000n + BigInt(stamp!.nanosec as number);
}

export function MotorControl({ bridge, jointState, urdfXml = "", status, statusTopic = "/stm32/status", commandTopic = "/stm32/joint_commands", onStreamingChange, controlLocked = false, active = true }: {
  bridge: BridgeClient; jointState: JointState | null; status: HardwareStatus | null; statusTopic?: string; commandTopic?: string;
  onStreamingChange(streaming: boolean): void; controlLocked?: boolean; active?: boolean; urdfXml?: string;
}) {
  const modelRanges = useMemo(() => parseMotorUrdfRanges(urdfXml), [urdfXml]);
  const [drive, setDrive] = useState<"MIT" | "POS_VEL">("MIT");
  const [mitMode, setMitMode] = useState<CommandMode>(DEFAULT_MODE);
  const [posMode, setPosMode] = useState<0 | 1>(1);
  const [mitMotors, setMitMotors] = useState<MotorRowInput[]>(() => createDefaultMotors());
  const [posMotors, setPosMotors] = useState<MotorRowInput[]>(blankPosMotors);
  const [velocityLimits, setVelocityLimits] = useState<string[]>(() => Array(7).fill(""));
  const [batchVelocity, setBatchVelocity] = useState("");
  const [velocity, setVelocity] = useState("0"), [kp, setKp] = useState(DEFAULT_KP), [kd, setKd] = useState(DEFAULT_KD), [effort, setEffort] = useState("0");
  const [armed, setArmed] = useState(false), [supportConfirmed, setSupportConfirmed] = useState(false), [showConfiguration, setShowConfiguration] = useState(false);
  const [streaming, setStreaming] = useState(false), [pending, setPending] = useState<Pending>(null), [stopRequested, setStopRequested] = useState(false);
  const [capabilities, setCapabilities] = useState<MotorControlCapabilities | null>(null), [capabilityError, setCapabilityError] = useState("");
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const [modeLog, setModeLog] = useState<MotorModeLogEntry[]>([]);
  const modeEvidenceRef = useRef("");
  const [result, setResult] = useState(""), [sequence, setSequence] = useState<number | undefined>();
  const timerRef = useRef<number | null>(null), mountedRef = useRef(true), operationRef = useRef(0), pendingRef = useRef<Pending>(null);
  const capsRef = useRef<MotorControlCapabilities | null>(null), seenV2Ref = useRef(false), canRunRef = useRef(active && !controlLocked);
  const stopProofRef = useRef<{ previous: MotorControlCapabilities | null; stamp: bigint | null; sequence?: number } | null>(null);
  const capsReceivedAtRef = useRef(0);
  const evidenceWatermarkRef = useRef<MotorEvidenceWatermark | null>(null);
  const statusStampRef = useRef<bigint | null>(null), callbackRef = useRef(onStreamingChange);
  callbackRef.current = onStreamingChange; canRunRef.current = active && !controlLocked;
  const mode = drive === "MIT" ? mitMode : posMode, motors = drive === "MIT" ? mitMotors : posMotors;
  const mask = selectedMotorMask(motors), selectedCount = motors.filter(row => row.enabled).length;
  const configurationMask = drive === "MIT" ? 0x7f : mask;
  const busy = streaming || pending !== null || stopRequested;
  const gate = !capabilities && !legacyConfirmed ? capabilityError || "正在读取驱动能力" : controlGate(capabilities, seenV2Ref.current, drive, mask);

  function logMode(message: string) { setModeLog(entries => appendMotorModeLog(entries, message)); }
  function setOperation(value: Pending) { pendingRef.current = value; setPending(value); }
  function stopTimer() {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null; setStreaming(false);
  }
  function finishStop() {
    stopProofRef.current = null; setStopRequested(false); setOperation(null); callbackRef.current(false);
    if (modeEvidenceRef.current) logMode("停止反馈：已核验输出关闭；此前模式事务结果保留，不代表模式切换成功。");
    setResult("已确认输出关闭；机械臂是否停稳请核对现场。重新开始需再次确认。");
  }
  function acceptCapabilities(value: MotorControlCapabilities) {
    if (value.supported) seenV2Ref.current = true;
    // Once V2 was observed, loss of its evidence must never restore legacy admission.
    let next = !value.supported && seenV2Ref.current && capsRef.current?.supported ? { ...capsRef.current, fresh: false, reason: value.reason || "V2 能力丢失" } : value;
    const accepted = acceptMotorEvidence(evidenceWatermarkRef.current, next);
    if (accepted.error) next = { ...(capsRef.current ?? next), fresh: false, reason: accepted.error };
    else if (accepted.advanced) { evidenceWatermarkRef.current = accepted.watermark; capsReceivedAtRef.current = Date.now() - next.age_ms; }
    else if (next.supported && next.fresh && capsRef.current) next = { ...capsRef.current, age_ms: Math.max(capsRef.current.age_ms, next.age_ms) };
    const previous = capsRef.current;
    if (!next.fresh || next.fault_code !== 0 || previous?.boot_id !== next.boot_id || previous?.control_epoch !== next.control_epoch || previous?.verified_joint_mask !== next.verified_joint_mask || previous?.control_modes.join() !== next.control_modes.join()) setArmed(false);
    if (accepted.advanced && next.supported && next.fresh && next.operation_id > 0) {
      const evidence = motorModeEvidence(next);
      if (evidence !== modeEvidenceRef.current) {
        modeEvidenceRef.current = evidence;
        logMode(`固件读回：${evidence}；${motorFirmwareRanges(next, next.selected_joint_mask)}`);
      }
    }
    capsRef.current = next; setCapabilities(next); setCapabilityError("");
    const proof = stopProofRef.current;
    if (proof?.previous && proof.sequence !== undefined && hasStopProof(next, proof.previous, proof.sequence)) finishStop();
  }
  async function disable() {
    ++operationRef.current; stopTimer(); setArmed(false); setSupportConfirmed(false); setShowConfiguration(false);
    setStopRequested(true); setOperation("stopping"); callbackRef.current(true);
    const proof = { previous: capsRef.current, stamp: statusStampRef.current, sequence: undefined as number | undefined };
    stopProofRef.current = proof; setResult("停止确认中：正在请求 DISABLE");
    try {
      const response = await bridge.request(createCommandPayload(3));
      if (!mountedRef.current || stopProofRef.current !== proof) return;
      proof.sequence = response.sequence; setSequence(response.sequence);
      setOperation(null); callbackRef.current(false);
      setResult("已请求 DISABLE，停止确认中；输出关闭状态以新鲜固件 / 原生任务反馈为准。");
      if (proof.previous && proof.sequence !== undefined && capsRef.current && hasStopProof(capsRef.current, proof.previous, proof.sequence)) finishStop();
    } catch (reason) {
      if (!mountedRef.current || stopProofRef.current !== proof) return;
      setOperation(null); callbackRef.current(false); setResult(`停止未确认：${String(reason)}`);
    }
  }
  const disableRef = useRef(disable); disableRef.current = disable;

  useEffect(() => {
    let disposed = false, inFlight = false;
    const refresh = async () => {
      if (!active) return;
      if (seenV2Ref.current && capsRef.current?.fresh && Date.now() - capsReceivedAtRef.current > 1500) {
        acceptCapabilities({ ...capsRef.current, fresh: false, reason: "驱动反馈未及时更新" });
        if (timerRef.current !== null) void disableRef.current();
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await bridge.request({ op: "motor_capabilities" });
        if (disposed) return;
        if (response.motor_control) acceptCapabilities(response.motor_control);
        else throw new Error("当前 Bridge 未提供 POS_VEL 能力");
      } catch (reason) {
        if (disposed) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setCapabilityError(message);
        if (!seenV2Ref.current && /未知操作|unknown.*op|unsupported.*op|未提供 POS_VEL 能力/i.test(message)) setLegacyConfirmed(true);
        if (seenV2Ref.current && capsRef.current) {
          acceptCapabilities({ ...capsRef.current, fresh: false, reason: message });
          if (timerRef.current !== null) void disableRef.current();
        }
      } finally { inFlight = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [bridge, active]);

  useEffect(() => bridge.onMessage(message => {
    if (message.motor_control) acceptCapabilities(message.motor_control);
    if (message.op === "disconnected") {
      setModeLog([]); modeEvidenceRef.current = "";
      ++operationRef.current; stopTimer(); setArmed(false); setSupportConfirmed(false); setLegacyConfirmed(false); setOperation(null); callbackRef.current(false);
      stopProofRef.current = null; setStopRequested(true);
      if (!seenV2Ref.current) { capsRef.current = null; setCapabilities(null); }
      if (seenV2Ref.current && capsRef.current) acceptCapabilities({ ...capsRef.current, fresh: false, reason: "连接已断开，等待重新读回" });
      setResult("连接已断开，控制已停止发送；输出关闭尚未确认。");
    }
    if (message.op === "error" && !message.request_id && timerRef.current !== null) {
      const error = message.message ?? "命令发送失败";
      void disableRef.current().then(() => { if (mountedRef.current) setResult(`${error}；已请求停止，等待反馈确认。`); });
    }
    if ((message.op === "joint_command_ack" || message.op === "motor_command_v2_ack") && message.sequence !== undefined) setSequence(message.sequence);
    if (message.op === "topic_message" && message.topic === statusTopic) {
      const stamp = sourceStamp(message.data), previousStamp = statusStampRef.current;
      if (stamp !== null && (previousStamp === null || stamp > previousStamp)) statusStampRef.current = stamp;
      const proof = stopProofRef.current, data = message.data as HardwareStatus | undefined;
      if (proof && proof.stamp === null && stamp !== null) proof.stamp = stamp;
      if (!seenV2Ref.current && proof && proof.sequence !== undefined && stamp !== null && (proof.stamp !== null && stamp > proof.stamp)
        && data?.mode === 3 && data.fault_code === 0 && data.last_command_sequence !== undefined
        && ((data.last_command_sequence - proof.sequence) >>> 0) < 0x80000000) finishStop();
    }
  }), [bridge, statusTopic]);

  useEffect(() => {
    if (active && !controlLocked) return;
    ++operationRef.current; const hadCommand = timerRef.current !== null || pendingRef.current !== null;
    stopTimer(); setArmed(false); setSupportConfirmed(false); setOperation(null); callbackRef.current(false);
    if (hadCommand) {
      void disableRef.current();
    }
  }, [active, controlLocked, bridge]);
  useEffect(() => {
    const count = Math.min(32, Math.max(DEFAULT_JOINT_COUNT, jointState?.name?.length ?? 0, jointState?.position?.length ?? 0));
    setMitMotors(current => resizeMotors(current, count));
  }, [jointState?.name?.length, jointState?.position?.length]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false; ++operationRef.current;
      const hadCommand = timerRef.current !== null || pendingRef.current !== null;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null; callbackRef.current(false);
      if (hadCommand) void bridge.request(createCommandPayload(3)).catch(() => undefined);
    };
  }, [bridge]);

  function edited() { setArmed(false); setSupportConfirmed(false); }
  function updateMotor(index: number, patch: Partial<MotorRowInput>) {
    edited();
    const update = (rows: MotorRowInput[]) => rows.map((row, i) => i === index ? { ...row, ...patch } : row);
    (drive === "MIT" ? setMitMotors : setPosMotors)(update);
    if (patch.enabled !== undefined) (drive === "MIT" ? setPosMotors : setMitMotors)(rows => rows.map((row, i) => i === index ? { ...row, enabled: patch.enabled! } : row));
  }
  function decimal(value: string, setter: (next: string) => void) {
    const normalized = normalizeDecimal(value); if (normalized !== null) { edited(); setter(normalized); }
  }
  function useCurrentPositions() {
    edited(); (drive === "MIT" ? setMitMotors : setPosMotors)(rows => rows.map((row, index) => {
      const feedback = jointState?.position?.[index]; return Number.isFinite(feedback) ? { ...row, position: String(feedback) } : row;
    }));
  }
  async function applyMode() {
    if (!supportConfirmed || !canRunRef.current || busy || !configurationMask) return;
    const current = capsRef.current;
    if (!current?.supported || !current.fresh || current.switching || !current.disabled_verified) { setResult("缺少新鲜驱动读回或输出关闭证明，不能应用模式"); return; }
    logMode(`申请 ${actualDriveMode(current, configurationMask)} → ${drive}；${motorAxisNames(configurationMask, jointState?.name)}；mask=${configurationMask}；${motorFirmwareRanges(current, configurationMask)}`);
    logMode("请求关闭输出、写入驱动模式并等待读回；尚未确认切换成功。");
    edited(); setOperation("configuring"); callbackRef.current(true); const operation = ++operationRef.current;
    setResult(`正在申请 ${drive}；等待关闭输出、写入及全部所选轴读回。`);
    try {
      const response = await bridge.request({ op: "motor_set_control_mode", boot_id: current.boot_id, control_epoch: current.control_epoch, active_joint_mask: configurationMask, control_mode: drive, confirmation: "ARMED", support_confirmation: "SUPPORTED" }, 30_000);
      if (!mountedRef.current || operation !== operationRef.current || !canRunRef.current) return;
      const next = response.motor_control;
      if (next) acceptCapabilities(next);
      if (response.op !== "motor_set_control_mode_result" || response.terminal !== true || !next || !next.disabled_verified || next.operation_state !== 2
        || next.control_epoch === current.control_epoch || capsRef.current?.control_epoch !== next.control_epoch || controlGate(capsRef.current, true, drive, configurationMask)) throw new Error(response.message || next?.reason || "模式未全部确认；禁止开始控制");
      logMode(`应用成功：${drive} 已读回；operation=${next.operation_id}；不会自动执行目标。`);
      setShowConfiguration(false); setResult(`实际驱动 ${drive} 已读回；请核对参数并重新安全确认。`);
    } catch (reason) {
      if (mountedRef.current && operation === operationRef.current) {
        logMode(`应用失败 / 结果未确认：${String(reason)}；请求 DISABLE，不会自动重试。`);
        if (capsRef.current) acceptCapabilities({ ...capsRef.current, fresh: false, reason: "配置结果未确认，请等待新鲜读回" });
        await disable();
        if (mountedRef.current) setResult(`模式应用失败 / 结果未确认：${String(reason)}。已请求停止，不会自动重试或执行目标。`);
      }
    } finally {
      if (mountedRef.current && operation === operationRef.current) { setOperation(null); callbackRef.current(false); }
    }
  }

  async function start() {
    if (!canRunRef.current || busy || pendingRef.current) return;
    if (!armed) { setResult("请先核对参数并勾选安全确认"); return; }
    const currentGate = !capsRef.current && !legacyConfirmed ? capabilityError || "正在读取驱动能力" : controlGate(capsRef.current, seenV2Ref.current, drive, mask);
    if (currentGate) { setResult(currentGate); return; }
    if (capsRef.current?.supported && !capsRef.current.disabled_verified) { setResult("请先停止并确认全部输出已关闭，再开始控制"); return; }
    const initialControl = capsRef.current;
    let payload: BridgeEnvelope;
    const parsedMit = drive === "MIT" ? parseCommandValues({ velocity, kp, kd, effort }, motors) : null;
    const parsedPos = drive === "POS_VEL" && capsRef.current ? parsePosVelValues(motors, velocityLimits, capsRef.current, mode) : null;
    if ((drive === "MIT" && !parsedMit?.values) || (drive === "POS_VEL" && !parsedPos?.values)) { setResult(parsedMit?.error || parsedPos?.error || "控制参数无效"); return; }
    setOperation("starting"); callbackRef.current(true); const operation = ++operationRef.current;
    try {
      if (drive === "POS_VEL") {
        const current = capsRef.current!;
        const lease = await bridge.request({ op: "motor_control_lease", lease_action: "acquire", boot_id: current.boot_id, control_epoch: current.control_epoch, active_joint_mask: mask, control_mode: "POS_VEL", confirmation: "ARMED" });
        if (!mountedRef.current || operation !== operationRef.current || !canRunRef.current) { void bridge.request(createCommandPayload(3)).catch(() => undefined); return; }
        const next = lease.motor_control;
        if (!next || next.boot_id !== current.boot_id || next.control_epoch !== current.control_epoch || !next.disabled_verified || next.lease_id <= 0 || !next.source_id || next.owner_source_id !== next.source_id || controlGate(next, true, drive, mask)) throw new Error("V2 控制租约未获确认");
        acceptCapabilities(next);
        if (capsRef.current?.lease_id !== next.lease_id || !capsRef.current?.fresh) throw new Error("拒绝旧的控制许可读回");
        payload = createPosVelPayload(posMode, parsedPos!.values!, next);
      } else payload = createCommandPayload(mitMode, parsedMit!.values!);
      const response = await bridge.request(payload);
      if (!mountedRef.current || operation !== operationRef.current || !canRunRef.current) { void bridge.request(createCommandPayload(3)).catch(() => undefined); return; }
      setSequence(response.sequence); setOperation(null); setStreaming(true); setResult("已发布；持续控制中。到位后仍保持，停止需请求 DISABLE。");
      timerRef.current = window.setInterval(() => {
        if (!canRunRef.current || operation !== operationRef.current) { stopTimer(); return; }
        if (seenV2Ref.current && (controlGate(capsRef.current, true, drive, mask) || Date.now() - capsReceivedAtRef.current > 1500
          || capsRef.current?.boot_id !== initialControl?.boot_id || capsRef.current?.control_epoch !== initialControl?.control_epoch
          || (drive === "POS_VEL" && (capsRef.current?.boot_id !== payload.boot_id || capsRef.current?.control_epoch !== payload.control_epoch || capsRef.current?.lease_id !== payload.lease_id || capsRef.current?.owner_source_id !== capsRef.current?.source_id)))) { void disableRef.current(); return; }
        try { bridge.send(payload); } catch { void disableRef.current(); }
      }, 50);
    } catch (reason) {
      if (!mountedRef.current || operation !== operationRef.current) return;
      setOperation(null); setArmed(false); callbackRef.current(false);
      await disable();
      if (mountedRef.current) setResult(`控制未开始：${String(reason)}；已请求停止。`);
    }
  }

  const selectedMode = modes.find(item => item.value === mode)!;
  const faultCode = capabilities?.supported ? capabilities.fault_code : status?.fault_code, currentFault = faultCode === undefined ? null : faultInfo(faultCode);
  const firmwareActive = status?.active_joints?.length ? status.active_joints.map(index => jointLabel(index)).join(", ") : status?.active_joint_mask !== undefined ? `mask 0x${status.active_joint_mask.toString(16)}` : "-";
  const posUnavailable = !capabilities?.supported || !capabilities.fresh || capabilities.pos_vel_supported_mask === 0;
  const posReason = capabilityError || capabilities?.reason || (capabilities?.pos_vel_supported_mask === 0 ? "尚无通过台架验证的 POS_VEL 轴" : "当前 Bridge / 固件未提供 POS_VEL 能力");
  const mainLabel = streaming ? "持续控制中" : pending === "starting" ? "正在开始…" : mode === 0 ? "保持当前位置" : drive === "POS_VEL" ? "执行目标并保持" : "开始控制";
  return <div className="motor-control">
    <section className="motor-status-card">
      <div className="control-status-row">
        <span className={faultCode === 0 ? "ok" : "fault"} title={currentFault?.description}>STM32 {capabilities?.supported ? `${capabilities.mode === 3 ? "DISABLE" : modes.find(item => item.value === capabilities.mode)?.label ?? "UNKNOWN"} · fault ${faultCode}` : status ? `${status.mode_name ?? status.mode} · fault ${faultCode} · ${currentFault?.name}` : "等待状态"}</span>
        <span>实际驱动：{!capabilities && !legacyConfirmed ? "等待能力探测" : actualDriveMode(capabilities, mask)}</span><span>已选 {selectedCount}/{motors.length}</span><span>固件可用轴 {firmwareActive}</span>
        <span>{pending === "configuring" ? "模式申请中" : stopRequested ? "停止确认中" : streaming ? "持续控制中" : "未开始控制"}</span>
      </div>
      {currentFault && faultCode !== 0 && <div className="fault-detail" role="status"><strong>FAULT {faultCode} · {currentFault.name}</strong><span>{currentFault.description}</span></div>}
    </section>
    <section className="motor-joints-card">
      <div className="motor-card-title"><div><strong>关节目标</strong><span>选择控制轴，核对实测位置与目标；两种驱动分别保留草稿</span></div><ActionButton className="use-current" disabled={busy} onClick={useCurrentPositions}>使用当前位置</ActionButton></div>
      {drive === "POS_VEL" && <div className="motor-batch-velocity"><label>统一速度上限 · rad/s<input aria-label="统一速度上限 · rad/s" type="text" inputMode="decimal" value={batchVelocity} disabled={busy} onChange={event => decimal(event.target.value, setBatchVelocity)} /></label><ActionButton disabled={busy || !mask} onClick={() => { edited(); setVelocityLimits(values => values.map((value, i) => motors[i]?.enabled ? batchVelocity : value)); }}>填写所选轴</ActionButton></div>}
      <div className="motor-list" role="list">{motors.map((motor, index) => {
        const feedback = jointState?.position?.[index], name = jointState?.name?.[index] ?? jointLabel(index);
        const range = motorRangeFor(modelRanges, name, index);
        const hasRange = range.min !== null && range.max !== null;
        const sliderMin = range.min ?? 0, sliderMax = range.max ?? 1;
        const sliderValue = hasRange ? Math.max(sliderMin, Math.min(sliderMax, Number(motor.position) || 0)) : 0.5;
        return <div className={`motor-row${motor.enabled ? " enabled" : ""}`} role="listitem" key={name}>
          <label className="motor-enable"><input type="checkbox" checked={motor.enabled} disabled={busy} aria-label={`${name} 选择控制`} onChange={event => updateMotor(index, { enabled: event.target.checked })} /><span>{name}</span></label>
          <label className="motor-position"><span className="motor-position-label">Position · rad</span><input type="range" min={sliderMin} max={sliderMax} step="any" disabled={busy || !motor.enabled || mode === 0 || !hasRange} value={sliderValue} aria-label={`${name} Position 滑块`} aria-describedby={`motor-range-${index}`} onChange={event => updateMotor(index, { position: event.target.value })} /><input type="text" inputMode="decimal" disabled={busy || !motor.enabled || mode === 0} value={motor.position} placeholder={drive === "POS_VEL" ? "请填写" : undefined} aria-label={`${name} Position · rad`} onChange={event => decimal(event.target.value, value => updateMotor(index, { position: value }))} /></label>
          {drive === "POS_VEL" && <label className="motor-velocity-limit">速度上限 · rad/s<input type="text" inputMode="decimal" disabled={busy || !motor.enabled} value={velocityLimits[index] ?? ""} placeholder="正数；按逐轴验证范围" aria-label={`${name} 速度上限 · rad/s`} onChange={event => decimal(event.target.value, value => setVelocityLimits(values => values.map((old, i) => i === index ? value : old)))} /></label>}
          <div className="motor-travel">{(["min", "max"] as const).map(bound => <label key={bound}>{bound}<input type="text" readOnly value={range[bound] === null ? "" : String(Number(range[bound]!.toPrecision(8)))} placeholder="—" title={range[bound] === null ? range.reason : String(range[bound])} aria-label={`${name} 行程 ${bound}`} /></label>)}<span className="motor-feedback" title="当前反馈">实测 {Number.isFinite(feedback) ? Number(feedback).toFixed(4) : "-"}</span></div>
          <small className="motor-range-source" id={`motor-range-${index}`}>{range.source}{range.reason ? ` · ${range.reason}` : " · rad"}</small>
        </div>;
      })}</div>
    </section>
    <aside className="motor-command-card">
      <div className="motor-card-title"><div><strong>电机控制</strong><span>模式选择仅编辑候选，实际模式以固件读回为准</span></div></div>
      <fieldset className="motor-drive-selector"><legend>驱动模式</legend>{(["MIT", "POS_VEL"] as const).map(value => <ActionButton key={value} aria-pressed={drive === value} disabled={busy || (value === "POS_VEL" && posUnavailable)} title={value === "POS_VEL" && posUnavailable ? posReason : undefined} onClick={() => { edited(); setDrive(value); setShowConfiguration(false); }}>{value}</ActionButton>)}</fieldset>
      {posUnavailable && <p className="mode-description">POS_VEL 不可用：{posReason}</p>}
      {capabilities?.supported && <div className="motor-mode-application"><span>{!capabilities.disabled_verified ? "先停止并验证输出关闭，才能应用驱动模式" : gate || `实际 ${drive} 已确认`}</span><ActionButton disabled={busy || !configurationMask || !capabilities.fresh || capabilities.switching || !capabilities.disabled_verified || capabilities.enabled_joint_mask !== 0 || !active || controlLocked || (drive === "POS_VEL" && (capabilities.pos_vel_supported_mask & mask) !== mask)} onClick={() => { setShowConfiguration(true); setSupportConfirmed(false); setArmed(false); }}>应用驱动模式…</ActionButton></div>}
      {showConfiguration && <div className="motor-mode-confirmation"><strong>{drive === "MIT" ? "恢复整组 MIT（7 轴）：" : "应用至 "}{motors.slice(0, 7).flatMap((row, i) => (drive === "MIT" || row.enabled) ? [jointState?.name?.[i] ?? jointLabel(i)] : []).join("、")}</strong><p>{actualDriveMode(capabilities, configurationMask)} → {drive}；申请期间会关闭输出，并逐轴写入、读回模式。</p><label className="arm-check"><input type="checkbox" aria-label="现场支撑确认" checked={supportConfirmed} disabled={busy} onChange={event => setSupportConfirmed(event.target.checked)} />已支撑机械臂，确认失能及模式切换不会造成跌落</label><ActionButton disabled={busy || !supportConfirmed} onClick={() => void applyMode()}>确认应用驱动模式</ActionButton><ActionButton disabled={busy} onClick={() => setShowConfiguration(false)}>取消</ActionButton></div>}
      {motorModeFailure(capabilities) && <div className="motor-mode-failure" role="note">{motorModeFailure(capabilities)}</div>}
      {drive === "POS_VEL" && capabilities?.supported && configurationMask !== 0 && <div className="motor-firmware-ranges">
        <strong>固件已验证范围{capabilities.fresh ? "" : "（反馈过期）"}</strong>
        <p>{motorFirmwareRanges(capabilities, configurationMask)}</p>
        <p>当前反馈：{motors.slice(0, 7).flatMap((row, i) => row.enabled ? [`joint${i + 1} ${formatMotorNumber(jointState?.position?.[i])} rad`] : []).join("；")}（仅供核对，切换以固件实时校验为准）</p>
      </div>}
      <label>执行状态<select value={mode} disabled={busy} onChange={event => { edited(); drive === "MIT" ? setMitMode(Number(event.target.value) as CommandMode) : setPosMode(Number(event.target.value) as 0 | 1); }}>{modes.filter(item => item.value !== 3 && (drive === "MIT" || item.value !== 2)).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <p className="mode-description">{drive === "MIT" ? selectedMode.description : mode === 0 ? "由固件锁存新鲜当前位置并保持；表单目标不下发" : "逐轴目标位置 + 正速度上限；执行后持续保持"}</p>
      {drive === "MIT" && <div className="command-grid shared-command-grid">{([["Velocity · rad/s", velocity, setVelocity], ["Kp", kp, setKp], ["Kd", kd, setKd], ["Effort · Nm", effort, setEffort]] as const).map(([label, value, setter]) => <label key={label}>{label}<input type="text" inputMode="decimal" disabled={busy} value={value} onChange={event => decimal(event.target.value, setter)} /></label>)}</div>}
      <label className="arm-check"><input type="checkbox" checked={armed} disabled={busy || controlLocked || !active || !!gate} aria-label="安全确认" onChange={event => setArmed(event.target.checked)} />已核对所选关节、参数及现场安全</label>
      <div className="control-actions"><ActionButton className="send-command" disabled={busy || controlLocked || !active || !armed || !!gate} onClick={() => void start()}>{mainLabel}</ActionButton><ActionButton className="stop-command" onClick={() => void disable()}>停止并 DISABLE</ActionButton></div>
      {streaming && <div className="streaming-indicator"><span />持续控制中 · {drive} / {selectedMode.label} · {selectedCount} 轴</div>}
      {result && <div className="command-result" aria-live="polite">{result}</div>}
      <details className="motor-mode-log" open>
        <summary>模式切换日志（{modeLog.length}）</summary>
        <small>保留本页当前连接最近 100 条记录；失败不会被停止确认覆盖。断开连接或关闭本页后清除。</small>
        <ActionButton disabled={busy || modeLog.length === 0} onClick={() => setModeLog([])}>清空切换日志</ActionButton>
        <div className="motor-mode-log-entries" role="log" aria-label="模式切换日志" aria-live="polite" tabIndex={0}>
          {modeLog.length === 0 ? <p>暂无切换记录</p> : modeLog.map((entry, i) => <p key={`${entry.at}-${i}`}><time dateTime={entry.at}>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false })}.{entry.at.slice(20, 23)}</time> {entry.message}</p>)}
        </div>
      </details>
      <details className="motor-control-details"><summary>控制详情</summary><dl><dt>指令流</dt><dd>20 Hz · 固定参数快照</dd><dt>sequence</dt><dd>{sequence ?? "—"}</dd><dt>lease</dt><dd>{drive === "POS_VEL" ? capabilities?.lease_id ?? "—" : "V1 原生准入"}</dd><dt>反馈龄上界</dt><dd>{capabilities ? `${capabilities.age_ms} ms${capabilities.fresh ? "" : "（过期）"}` : "旧协议"}</dd><dt>Topic</dt><dd>{drive === "POS_VEL" ? `${commandTopic}_v2` : commandTopic}</dd></dl></details>
      <small className="safety-note">停止或离开页面会请求关闭输出，结果以新鲜固件反馈为准。滑块范围来自当前 URDF；POS_VEL 下发还须满足固件已验证范围。未选择的轴不发送运动目标。断流可能触发故障锁存，不会自动恢复控制。</small>
    </aside>
  </div>;
}
