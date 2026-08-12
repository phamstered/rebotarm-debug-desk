import { useEffect, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import type { HardwareStatus } from "./types";
import { createCommandPayload, DEFAULT_KD, DEFAULT_KP, DEFAULT_MODE, faultInfo, modes, normalizeDecimal, parseCommandValues } from "./motorLogic";
import type { CommandMode } from "./motorLogic";

type JointState = { position?: number[]; velocity?: number[]; effort?: number[] };
function updateDecimal(value: string, setter: (value: string) => void) {
  const normalized = normalizeDecimal(value);
  if (normalized !== null) setter(normalized);
}

export function MotorControl({
  bridge,
  jointState,
  status,
  onStreamingChange,
}: {
  bridge: BridgeClient;
  jointState: JointState | null;
  status: HardwareStatus | null;
  onStreamingChange(streaming: boolean): void;
}) {
  const [mode, setMode] = useState<CommandMode>(DEFAULT_MODE);
  const [position, setPosition] = useState("0");
  const [velocity, setVelocity] = useState("0");
  const [kp, setKp] = useState(DEFAULT_KP);
  const [kd, setKd] = useState(DEFAULT_KD);
  const [effort, setEffort] = useState("0");
  const [armed, setArmed] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [result, setResult] = useState("");
  const timerRef = useRef<number | null>(null);

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

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    onStreamingChange(false);
  }, [onStreamingChange]);

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
    const parsed = parseCommandValues({ position, velocity, kp, kd, effort });
    if (!parsed.values) {
      setResult(parsed.error ?? "控制参数无效");
      return;
    }
    const values = parsed.values;
    try {
      const response = await bridge.request(createCommandPayload(mode, values));
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

  const useCurrentPosition = () => {
    const current = jointState?.position?.[0];
    if (Number.isFinite(current)) setPosition(String(Number(current)));
  };
  const selected = modes.find((item) => item.value === mode)!;
  const faultCode = status?.fault_code;
  const currentFault = faultCode === undefined
    ? null
    : faultInfo(faultCode);

  return (
    <div className="motor-control">
      <div className="control-status-row">
        <span className={faultCode === 0 ? "ok" : "fault"} title={currentFault?.description}>
          STM32 {status ? `${status.mode_name ?? status.mode} · fault ${faultCode} · ${currentFault?.name}` : "等待状态"}
        </span>
        <span>p {jointState?.position?.[0]?.toFixed(4) ?? "-"}</span>
        <span>v {jointState?.velocity?.[0]?.toFixed(4) ?? "-"}</span>
      </div>
      {currentFault && faultCode !== 0 && (
        <div className="fault-detail" role="status">
          <strong>FAULT {faultCode} · {currentFault.name}</strong>
          <span>{currentFault.description}</span>
        </div>
      )}

      <label>MIT 命令模式
        <select value={mode} disabled={streaming} onChange={(event) => setMode(Number(event.target.value) as CommandMode)}>
          {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <p className="mode-description">{selected.description}</p>

      <div className="command-grid">
        <label>Position · rad<input type="text" inputMode="decimal" value={position} onChange={(event) => updateDecimal(event.target.value, setPosition)} /></label>
        <label>Velocity · rad/s<input type="text" inputMode="decimal" value={velocity} onChange={(event) => updateDecimal(event.target.value, setVelocity)} /></label>
        <label>Kp<input type="text" inputMode="decimal" value={kp} onChange={(event) => updateDecimal(event.target.value, setKp)} /></label>
        <label>Kd<input type="text" inputMode="decimal" value={kd} onChange={(event) => updateDecimal(event.target.value, setKd)} /></label>
        <label>Effort · Nm<input type="text" inputMode="decimal" value={effort} onChange={(event) => updateDecimal(event.target.value, setEffort)} /></label>
        <button className="use-current" onClick={useCurrentPosition}>使用当前位置</button>
      </div>

      <label className="arm-check">
        <input type="checkbox" checked={armed} disabled={streaming || mode === 3} onChange={(event) => {
          setArmed(event.target.checked);
        }} />
        我已确认机械臂周围安全，本次连接允许发送电机指令
      </label>

      <div className="control-actions">
        <button className="send-command" disabled={streaming || (mode !== 3 && !armed)} onClick={start}>
          {mode === 3 ? "发送 DISABLE" : "开始 20 Hz 发送"}
        </button>
        <button className="stop-command" onClick={disable}>停止并 DISABLE</button>
      </div>
      {streaming && <div className="streaming-indicator"><span /> 正在发送 {selected.label}</div>}
      {result && <div className="command-result">{result}</div>}
      <small className="safety-note">断开或停止发送后，固件将在 100 ms进入 HOLD，并在 500 ms后 DISABLE。</small>
    </div>
  );
}
