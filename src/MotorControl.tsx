import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { HardwareStatus } from "./types";
import {
  createCommandPayload,
  createDefaultMotors,
  DEFAULT_JOINT_COUNT,
  DEFAULT_KD,
  DEFAULT_KP,
  DEFAULT_MODE,
  faultInfo,
  jointLabel,
  modes,
  normalizeDecimal,
  parseCommandValues,
  parseTravelBound,
  resizeMotors,
} from "./motorLogic";
import type { CommandMode, MotorRowInput } from "./motorLogic";

type JointState = { name?: string[]; position?: number[]; velocity?: number[]; effort?: number[] };

function updateDecimal(value: string, setter: (value: string) => void) {
  const normalized = normalizeDecimal(value);
  if (normalized !== null) setter(normalized);
}

function inferredJointCount(jointState: JointState | null): number {
  const fromNames = jointState?.name?.length ?? 0;
  const fromPositions = jointState?.position?.length ?? 0;
  const count = Math.max(fromNames, fromPositions);
  return Math.min(32, Math.max(DEFAULT_JOINT_COUNT, count));
}

export function MotorControl({
  bridge,
  jointState,
  status,
  onStreamingChange,
  controlLocked = false,
}: {
  bridge: BridgeClient;
  jointState: JointState | null;
  status: HardwareStatus | null;
  onStreamingChange(streaming: boolean): void;
  controlLocked?: boolean;
}) {
  const [mode, setMode] = useState<CommandMode>(DEFAULT_MODE);
  const [motors, setMotors] = useState<MotorRowInput[]>(() => createDefaultMotors());
  const [velocity, setVelocity] = useState("0");
  const [kp, setKp] = useState(DEFAULT_KP);
  const [kd, setKd] = useState(DEFAULT_KD);
  const [effort, setEffort] = useState("0");
  const [armed, setArmed] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState("");
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const preflightPendingRef = useRef(false);

  const jointCount = inferredJointCount(jointState);

  useEffect(() => {
    if (controlLocked && streaming) {
      // Gravity ID (or other exclusive session) owns the arm — stop Motor stream; leave DISABLE to operator.
      setStreaming(false);
      setResult("控制已锁定：已停止 Motor 连续发送");
    }
  }, [controlLocked, streaming]);
  useEffect(() => {
    setMotors((current) => resizeMotors(current, jointCount));
  }, [jointCount]);

  const stopTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setStreaming(false);
    onStreamingChange(false);
  };

  useEffect(() => {
    return bridge.onMessage((message) => {
      if (message.op === "error" && !message.request_id) {
        stopTimer();
        setResult(message.message ?? "命令发送失败");
      }
      if (message.op === "joint_command_ack" && message.sequence !== undefined) {
        setResult(`已发送 sequence=${message.sequence}`);
      }
    });
  }, [bridge]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const shouldDisable = timerRef.current !== null || preflightPendingRef.current;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      onStreamingChange(false);
      if (shouldDisable) void bridge.request(createCommandPayload(3)).catch(() => undefined);
    };
  }, [bridge, onStreamingChange]);

  const updateMotor = (index: number, patch: Partial<MotorRowInput>) => {
    setMotors((current) => current.map((motor, motorIndex) => (
      motorIndex === index ? { ...motor, ...patch } : motor
    )));
  };

  async function start() {
    setResult("");
    if (mode === 3) {
      await disable();
      return;
    }
    if (!armed) {
      setResult("请先勾选安全确认并解锁控制");
      return;
    }
    const parsed = parseCommandValues({ velocity, kp, kd, effort }, motors);
    if (!parsed.values) {
      setResult(parsed.error ?? "控制参数无效");
      return;
    }
    const values = parsed.values;
    preflightPendingRef.current = true;
    try {
      const response = await bridge.request(createCommandPayload(mode, values));
      preflightPendingRef.current = false;
      if (!mountedRef.current) return;
      setResult(`预检通过，sequence=${response.sequence ?? "-"}`);
      stopTimer();
      timerRef.current = window.setInterval(() => {
        try {
          bridge.send(createCommandPayload(mode, values));
        } catch (reason) {
          stopTimer();
          setResult(reason instanceof Error ? reason.message : String(reason));
        }
      }, 50);
      setStreaming(true);
      onStreamingChange(true);
    } catch (reason) {
      preflightPendingRef.current = false;
      if (!mountedRef.current) return;
      stopTimer();
      setResult(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function disable() {
    stopTimer();
    try {
      const response = await bridge.request(createCommandPayload(3));
      setResult(`DISABLE 已发送，sequence=${response.sequence ?? "-"}`);
    } catch (reason) {
      setResult(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const useCurrentPositions = () => {
    setMotors((current) => current.map((motor, index) => {
      const feedback = jointState?.position?.[index];
      if (!Number.isFinite(feedback)) return motor;
      return { ...motor, position: String(Number(feedback)) };
    }));
  };

  const selected = modes.find((item) => item.value === mode)!;
  const faultCode = status?.fault_code;
  const currentFault = faultCode === undefined ? null : faultInfo(faultCode);
  const enabledCount = useMemo(() => motors.filter((motor) => motor.enabled).length, [motors]);
  const firmwareActive = status?.active_joints?.length
    ? status.active_joints.map((index) => jointLabel(index)).join(", ")
    : status?.active_joint_mask !== undefined
      ? `mask 0x${status.active_joint_mask.toString(16)}`
      : "-";

  return (
    <div className="motor-control">
      <section className="motor-status-card">
        <div className="control-status-row">
          <span className={faultCode === 0 ? "ok" : "fault"} title={currentFault?.description}>
            STM32 {status ? `${status.mode_name ?? status.mode} · fault ${faultCode} · ${currentFault?.name}` : "等待状态"}
          </span>
          <span>使能 {enabledCount}/{motors.length}</span>
          <span>固件 active {firmwareActive}</span>
        </div>
        {currentFault && faultCode !== 0 && (
          <div className="fault-detail" role="status">
            <strong>FAULT {faultCode} · {currentFault.name}</strong>
            <span>{currentFault.description}</span>
          </div>
        )}
      </section>

      <section className="motor-joints-card">
        <div className="motor-card-title">
          <div><strong>关节目标</strong><span>逐关节设置 Position、使能状态与滑块行程</span></div>
          <button className="use-current" onClick={useCurrentPositions}>使用当前位置</button>
        </div>
        <div className="motor-list" role="list">
          {motors.map((motor, index) => {
            const minBound = parseTravelBound(motor.min, "min");
            const maxBound = parseTravelBound(motor.max, "max");
            const min = minBound.value ?? -0.35;
            const max = maxBound.value ?? 0.35;
            const sliderMin = Math.min(min, max);
            const sliderMax = Math.max(min, max);
            const feedback = jointState?.position?.[index];
            const name = jointState?.name?.[index] ?? jointLabel(index);
            return (
              <div className={`motor-row${motor.enabled ? " enabled" : ""}`} role="listitem" key={name}>
                <label className="motor-enable">
                  <input
                    type="checkbox"
                    checked={motor.enabled}
                    disabled={streaming}
                    aria-label={`${name} 使能`}
                    onChange={(event) => updateMotor(index, { enabled: event.target.checked })}
                  />
                  <span>{name}</span>
                </label>
                <label className="motor-position">
                  <span className="motor-position-label">Position · rad</span>
                  <input
                    type="range"
                    min={sliderMin}
                    max={sliderMax}
                    step={0.001}
                    disabled={streaming || !motor.enabled}
                    value={Number(motor.position) || 0}
                    aria-label={`${name} Position 滑块`}
                    onChange={(event) => updateMotor(index, { position: event.target.value })}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={streaming || !motor.enabled}
                    value={motor.position}
                    aria-label={`${name} Position · rad`}
                    onChange={(event) => {
                      const normalized = normalizeDecimal(event.target.value);
                      if (normalized !== null) updateMotor(index, { position: normalized });
                    }}
                  />
                </label>
                <div className="motor-travel">
                  <label>min
                    <input
                      type="text"
                      inputMode="decimal"
                      disabled={streaming}
                      value={motor.min}
                      aria-label={`${name} 行程 min`}
                      onChange={(event) => updateDecimal(event.target.value, (value) => updateMotor(index, { min: value }))}
                    />
                  </label>
                  <label>max
                    <input
                      type="text"
                      inputMode="decimal"
                      disabled={streaming}
                      value={motor.max}
                      aria-label={`${name} 行程 max`}
                      onChange={(event) => updateDecimal(event.target.value, (value) => updateMotor(index, { max: value }))}
                    />
                  </label>
                  <span className="motor-feedback" title="当前反馈">
                    p {Number.isFinite(feedback) ? Number(feedback).toFixed(4) : "-"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <aside className="motor-command-card">
        <div className="motor-card-title"><div><strong>共享 MIT 参数</strong><span>应用于所有已使能关节</span></div></div>
        <label>MIT 命令模式
          <select value={mode} disabled={streaming} onChange={(event) => setMode(Number(event.target.value) as CommandMode)}>
            {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <p className="mode-description">{selected.description}</p>
        <div className="command-grid shared-command-grid">
          <label>Velocity · rad/s<input type="text" inputMode="decimal" value={velocity} onChange={(event) => updateDecimal(event.target.value, setVelocity)} /></label>
          <label>Kp<input type="text" inputMode="decimal" value={kp} onChange={(event) => updateDecimal(event.target.value, setKp)} /></label>
          <label>Kd<input type="text" inputMode="decimal" value={kd} onChange={(event) => updateDecimal(event.target.value, setKd)} /></label>
          <label>Effort · Nm<input type="text" inputMode="decimal" value={effort} onChange={(event) => updateDecimal(event.target.value, setEffort)} /></label>
        </div>

        <label className="arm-check">
          <input type="checkbox" checked={armed} disabled={streaming || controlLocked || mode === 3} aria-label="安全确认" onChange={(event) => {
            setArmed(event.target.checked);
          }} />
          我已确认机械臂周围安全，本次连接允许发送电机指令
        </label>

        <div className="control-actions">
          <button className="send-command" disabled={streaming || controlLocked || (mode !== 3 && !armed)} onClick={start}>
            {mode === 3 ? "发送 DISABLE" : "开始 20 Hz 发送"}
          </button>
          <button className="stop-command" onClick={disable}>停止并 DISABLE</button>
        </div>
        {streaming && <div className="streaming-indicator"><span /> 正在发送 {selected.label}（{enabledCount} 关节）</div>}
        {result && <div className="command-result">{result}</div>}
        <small className="safety-note">
          仅对已使能且固件 active_joint_mask 覆盖的关节写入非零通道；其余通道保持 0。行程 min/max 只约束滑块范围（默认 ±0.35 rad），不做 Bridge 限幅。
          断开或停止发送后，固件将在 100 ms进入 HOLD，并在 500 ms后 DISABLE。
        </small>
      </aside>
    </div>
  );
}
