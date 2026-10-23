import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "./bridge";
import {
  FIRMWARE_SAFETY_NOTES,
  JOINT_BIT_LABELS,
  MODE_FULL_ARM_GRAVITY,
  MODE_PAYLOAD_SUBMODE,
  PAYLOAD_MODE_UI_HINT,
  STACK_BRINGUP_NOTES,
  buildGravityIdCancelPayload,
  buildGravityIdSendGoalPayload,
  canAbortGravityId,
  canSendGravityIdGoal,
  defaultGravityIdGoalForm,
  faultCodeLabel,
  isPayloadModeBlocked,
  isSessionRunningPhase,
  jointBitsFromMask,
  jointMaskFromBits,
  parseGravityIdFeedback,
  parseGravityIdResult,
  phaseLabel,
  sessionStateFromPhase,
  type GravityIdFeedback,
  type GravityIdGoalForm,
  type GravityIdResult,
} from "./gravityIdentificationLogic";
import type { BridgeEnvelope } from "./types";

function fmt(value: number | undefined, digits = 4) {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function EffortRow({
  label,
  values,
}: {
  label: string;
  values: number[];
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {JOINT_BIT_LABELS.map((name, index) => (
        <td key={`${label}-${name}`}>{fmt(values[index], 3)}</td>
      ))}
    </tr>
  );
}

export function GravityIdentificationPage({
  bridge,
  onNavigateCalibration,
  onSessionActiveChange,
}: {
  bridge: BridgeClient;
  onNavigateCalibration(): void;
  onSessionActiveChange?(active: boolean): void;
}) {
  const [form, setForm] = useState<GravityIdGoalForm>(() => defaultGravityIdGoalForm());
  const [armed, setArmed] = useState(false);
  const [session, setSession] = useState<"idle" | "running" | "canceling">("idle");
  const [feedback, setFeedback] = useState<GravityIdFeedback | null>(null);
  const [result, setResult] = useState<GravityIdResult | null>(null);
  const [statusText, setStatusText] = useState("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"start" | "abort" | "">("");

  const jointBits = useMemo(() => jointBitsFromMask(form.jointMask), [form.jointMask]);
  const phase = feedback?.phase;
  const running = session === "running" || session === "canceling" ||
    (phase !== undefined && isSessionRunningPhase(phase));
  const startAllowed = canSendGravityIdGoal(armed ? "ARMED" : "", session) && !busy;
  const abortAllowed = canAbortGravityId(session) || running;

  useEffect(() => {
    onSessionActiveChange?.(running);
    return () => onSessionActiveChange?.(false);
  }, [running, onSessionActiveChange]);

  useEffect(() => {
    const unsubscribe = bridge.onMessage((message: BridgeEnvelope) => {
      if (message.op === "gravity_id_feedback") {
        const parsed = parseGravityIdFeedback(message);
        if (parsed) {
          setFeedback(parsed);
          setSession(sessionStateFromPhase(parsed.phase));
          setError("");
        }
        return;
      }
      if (message.op === "gravity_id_result") {
        const parsed = parseGravityIdResult(message);
        if (parsed) {
          setResult(parsed);
          setSession("idle");
          setNotice(parsed.success ? (parsed.message || "辨识完成") : (parsed.message || "辨识失败"));
          if (!parsed.success) setError(parsed.message || "GravityIdentification 失败");
        }
        return;
      }
      if (message.op === "gravity_id_status" && typeof message.message !== "string") {
        const status = String((message as BridgeEnvelope & { status?: string }).status ?? "");
        if (status) {
          setStatusText(status);
          if (status === "idle" || status === "rejected") setSession("idle");
          else if (status === "canceling") setSession("canceling");
          else if (status === "executing" || status === "accepted") setSession("running");
        }
      }
      if (message.op === "disconnected") {
        setSession("idle");
        setFeedback(null);
        setStatusText("idle");
      }
    });
    return unsubscribe;
  }, [bridge]);

  function updateForm<K extends keyof GravityIdGoalForm>(key: K, value: GravityIdGoalForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function start() {
    setBusy("start");
    setError("");
    setNotice("");
    setResult(null);
    try {
      const built = buildGravityIdSendGoalPayload(
        form,
        armed ? "ARMED" : "",
        crypto.randomUUID(),
      );
      if (!built.ok) throw new Error(built.error);
      await bridge.request(built.payload as never);
      setSession("running");
      setNotice("Goal 已发送，等待 Feedback…");
    } catch (reason) {
      setSession("idle");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function abort() {
    setBusy("abort");
    setError("");
    try {
      await bridge.request(buildGravityIdCancelPayload(crypto.randomUUID()) as never);
      setSession("canceling");
      setNotice("已请求 Abort → 目标 HOLD（非 DISABLE）");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="calibration-page gravity-id-page">
      <header className="calibration-header">
        <div>
          <strong>重力辨识</strong>
          <span>/StartGravityID · FULL_ARM（stack #24）</span>
        </div>
        <div className="calibration-connection">
          <strong>SESSION</strong>
          <small>{statusText}{phase !== undefined ? ` · ${phaseLabel(phase)}` : ""}</small>
        </div>
      </header>

      <div className="calibration-safety-banner" role="note">
        <strong>固件约束</strong>
        <span>
          {FIRMWARE_SAFETY_NOTES.map((note) => (
            <span key={note} className="gravity-id-note-line">{note}</span>
          ))}
        </span>
        <button type="button" className="ghost" onClick={onNavigateCalibration}>
          Joint4 标定
        </button>
      </div>

      <div className="calibration-notice gravity-id-bringup" role="note">
        <strong>Jetson bring-up（stack #24）</strong>
        {STACK_BRINGUP_NOTES.map((note) => (
          <span key={note} className="gravity-id-note-line">{note}</span>
        ))}
        <span className="gravity-id-note-line">
          FULL_ARM：内置 12 姿态；TRACK@v≈0 + Pinocchio 前馈；YAML + gravity_compensation hot-reload 由编排器完成（Desk 只发 Goal）。
        </span>
      </div>

      {error && <div className="calibration-alert" role="alert"><div><strong>错误</strong><span>{error}</span></div></div>}
      {notice && <div className="calibration-notice">{notice}</div>}

      <div className="calibration-grid gravity-id-grid">
        <section className="calibration-control-card">
          <div className="calibration-card-title">
            <div>
              <strong>Goal</strong>
              <span>IDL #23 · 编排 #24 FULL_ARM</span>
            </div>
          </div>

          <div className="gravity-id-joint-mask" role="group" aria-label="关节掩码">
            {JOINT_BIT_LABELS.map((label, index) => (
              <label key={label}>
                <input
                  type="checkbox"
                  checked={jointBits[index]}
                  disabled={running}
                  aria-label={label}
                  onChange={(event) => {
                    const next = [...jointBits];
                    next[index] = event.target.checked;
                    updateForm("jointMask", jointMaskFromBits(next));
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <small className="safety-note">默认全选 0x3F；全不选时 Bridge/action 按 0x3F。</small>

          <label>模式
            <select
              value={form.mode}
              disabled={running}
              aria-label="辨识模式"
              onChange={(event) => updateForm("mode", Number(event.target.value))}
            >
              <option value={MODE_FULL_ARM_GRAVITY}>FULL_ARM_GRAVITY（默认）</option>
              <option value={MODE_PAYLOAD_SUBMODE}>PAYLOAD_SUBMODE → Joint4</option>
            </select>
          </label>

          {form.mode === MODE_PAYLOAD_SUBMODE && (
            <div className="gravity-id-payload-hint" role="status">
              <p>{PAYLOAD_MODE_UI_HINT}</p>
              <p className="gravity-id-note-line">与 stack 拒绝文案一致：v1 only supports FULL_ARM_GRAVITY。</p>
              <button type="button" className="primary" onClick={onNavigateCalibration}>
                打开 Joint4 标定
              </button>
            </div>
          )}

          <div className="command-grid shared-command-grid">
            <label>settle_time_s
              <input type="number" step="0.1" min="0" disabled={running} value={form.settleTimeS}
                onChange={(e) => updateForm("settleTimeS", Number(e.target.value))} />
            </label>
            <label>capture_window_s
              <input type="number" step="0.1" min="0" disabled={running} value={form.captureWindowS}
                onChange={(e) => updateForm("captureWindowS", Number(e.target.value))} />
            </label>
            <label>max_effort_nm
              <input type="number" step="0.1" min="0" disabled={running} value={form.maxEffortNm}
                onChange={(e) => updateForm("maxEffortNm", Number(e.target.value))} />
            </label>
            <label>max_velocity_rad_s
              <input type="number" step="0.01" min="0" disabled={running} value={form.maxVelocityRadS}
                onChange={(e) => updateForm("maxVelocityRadS", Number(e.target.value))} />
            </label>
            <label>command_timeout_ms
              <input type="number" step="1" min="0" disabled={running} value={form.commandTimeoutMs}
                onChange={(e) => updateForm("commandTimeoutMs", Number(e.target.value))} />
            </label>
            <small className="safety-note">仅对齐 host/编排侧期望；MCU 仍为编译期约 100 ms HOLD / 500 ms fault 11，本字段不改固件超时。</small>
            <label>output_yaml_path
              <input type="text" disabled={running} value={form.outputYamlPath}
                placeholder="空= stack 默认路径"
                onChange={(e) => updateForm("outputYamlPath", e.target.value)} />
            </label>
          </div>

          <label className="arm-check">
            <input type="checkbox" checked={form.writeYaml} disabled={running}
              onChange={(e) => updateForm("writeYaml", e.target.checked)} />
            write_yaml
          </label>
          <label className="arm-check">
            <input type="checkbox" checked={form.hotReload} disabled={running}
              onChange={(e) => updateForm("hotReload", e.target.checked)} />
            hot_reload（stack #24：写 YAML 后 set_parameters → gravity_compensation_controller）
          </label>
          <label className="arm-check">
            <input type="checkbox" checked={form.lockGripper} disabled={running}
              onChange={(e) => updateForm("lockGripper", e.target.checked)} />
            lock_gripper
          </label>

          <label className="arm-check">
            <input
              type="checkbox"
              checked={armed}
              disabled={running}
              aria-label="安全确认"
              onChange={(e) => setArmed(e.target.checked)}
            />
            我已确认机械臂周围安全，允许发送 GravityIdentification Goal（ARMED）
          </label>

          <div className="control-actions gravity-id-actions">
            <button type="button" className="primary" disabled={!startAllowed || isPayloadModeBlocked(form.mode)} onClick={() => void start()}>
              {busy === "start" ? "发送中…" : "Start"}
            </button>
            <button type="button" className="danger" disabled={!abortAllowed && busy !== "abort"} onClick={() => void abort()}>
              {busy === "abort" ? "中止中…" : "Abort"}
            </button>
          </div>
          {isPayloadModeBlocked(form.mode) && (
            <small className="safety-note" role="status">{PAYLOAD_MODE_UI_HINT}</small>
          )}
          <small className="safety-note">
            Abort 始终可用（运行中）；目标为固件 HOLD，不是 DISABLE。fault 11（命令丢失）同样 → HOLD。
          </small>
        </section>

        <section className="calibration-status-card">
          <div className="calibration-card-title">
            <div>
              <strong>Feedback</strong>
              <span>Bridge 推送 ≤10 Hz</span>
            </div>
          </div>
          <div className="calibration-metrics">
            <div><span>phase</span><strong>{phase !== undefined ? phaseLabel(phase) : "—"}</strong></div>
            <div><span>pose</span><strong>{feedback ? `${feedback.poseIndex}/${feedback.poseCount}` : "—"}</strong></div>
            <div><span>rmse_running</span><strong>{fmt(feedback?.rmseRunning, 4)}</strong></div>
            <div><span>fault</span><strong>{feedback ? faultCodeLabel(feedback.faultCode) : "—"}</strong></div>
          </div>
          <p className="gravity-id-message">{feedback?.message || "等待 Feedback…"}</p>
          <div className="gravity-id-table-wrap">
            <table className="gravity-id-table">
              <thead>
                <tr>
                  <th scope="col"> </th>
                  {JOINT_BIT_LABELS.map((name) => <th key={name} scope="col">{name}</th>)}
                </tr>
              </thead>
              <tbody>
                <EffortRow label="residual" values={feedback?.residualNm ?? []} />
                <EffortRow label="measured" values={feedback?.measuredEffortNm ?? []} />
                <EffortRow label="model" values={feedback?.modelEffortNm ?? []} />
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="calibration-fit-card gravity-id-result-card">
        <div className="calibration-card-title">
          <div>
            <strong>Result</strong>
            <span>{result ? (result.success ? "success" : "failed") : "尚未结束"}</span>
          </div>
        </div>
        {result ? (
          <>
            <div className="calibration-metrics">
              <div><span>rmse_total</span><strong>{fmt(result.rmseTotal, 4)}</strong></div>
              <div><span>fault</span><strong>{faultCodeLabel(result.faultCode)}</strong></div>
              <div><span>yaml_path</span><strong className="gravity-id-path">{result.yamlPath || "—"}</strong></div>
              <div><span>message</span><strong>{result.message || "—"}</strong></div>
            </div>
            <div className="gravity-id-table-wrap">
              <table className="gravity-id-table">
                <thead>
                  <tr>
                    <th scope="col"> </th>
                    {JOINT_BIT_LABELS.map((name) => <th key={name} scope="col">{name}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <EffortRow label="scales" values={result.gravityScales} />
                  <EffortRow label="biases" values={result.torqueBiasesNm} />
                  <EffortRow label="rmse" values={result.rmsePerJoint} />
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="gravity-id-message">Start 成功结束后显示 scales / biases / per-joint RMSE。</p>
        )}
      </section>
    </main>
  );
}
