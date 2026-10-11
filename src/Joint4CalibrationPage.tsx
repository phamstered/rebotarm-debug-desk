import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { BridgeClient } from "./bridge";
import {
  buildCalibrationReport,
  calibrationAvailability,
  JOINT4_CALIBRATION_LIMITS,
  JOINT4_CALIBRATION_STATUS_TOPIC,
  parseFitResult,
  parseJoint4CalibrationStatus,
  sampleFromCaptureMessage,
} from "./joint4CalibrationLogic";
import type {
  Joint4CalibrationSample,
  Joint4CalibrationStatus,
  Joint4FitResult,
} from "./joint4CalibrationLogic";
import type { BridgeEnvelope, ConnectionProfile } from "./types";

type CalibrationAction = "begin_pose" | "release_pose" | "capture_pose" | "fit" | "reset";
type TriggerServiceResponse = { success: boolean; message: string };

function value(value: number | undefined, digits = 4) {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function SampleChart({ samples }: { samples: Joint4CalibrationSample[] }) {
  if (samples.length < 2) return <div className="calibration-chart-empty">采集至少两个姿态后显示力矩曲线</div>;
  const width = 560;
  const height = 190;
  const padding = 28;
  const xs = samples.map((sample) => sample.q4);
  const ys = samples.flatMap((sample) => [sample.modelEffort, sample.requiredEffort]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const x = (input: number) => padding + ((input - xMin) / Math.max(xMax - xMin, 1e-6)) * (width - padding * 2);
  const y = (input: number) => height - padding - ((input - yMin) / Math.max(yMax - yMin, 1e-6)) * (height - padding * 2);
  const points = (selector: (sample: Joint4CalibrationSample) => number) => samples
    .map((sample) => `${x(sample.q4)},${y(selector(sample))}`).join(" ");
  return (
    <div className="calibration-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="joint4 姿态力矩曲线">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} />
        <polyline className="model-line" points={points((sample) => sample.modelEffort)} />
        <polyline className="required-line" points={points((sample) => sample.requiredEffort)} />
        {samples.map((sample) => <circle key={`required-${sample.pose}`} className="required-point" cx={x(sample.q4)} cy={y(sample.requiredEffort)} r="4" />)}
      </svg>
      <div><span className="model-key" />URDF 重力矩 <span className="required-key" />所需总力矩 <small>横轴 q4 · 纵轴 N·m</small></div>
    </div>
  );
}

export function Joint4CalibrationPage({
  profile,
  bridge,
  controllerState,
  onRefreshControllers,
  pageSwitch,
}: {
  profile: ConnectionProfile;
  bridge: BridgeClient;
  controllerState?: string;
  onRefreshControllers(): void;
  /** 顶部工具栏的页面切换按钮，由 App 注入以保证两个页面都能切换。 */
  pageSwitch?: ReactNode;
}) {
  const [status, setStatus] = useState<Joint4CalibrationStatus | null>(null);
  const [samples, setSamples] = useState<Joint4CalibrationSample[]>([]);
  const [fit, setFit] = useState<Joint4FitResult | null>(null);
  const [busy, setBusy] = useState<CalibrationAction | "save" | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [subscriptionError, setSubscriptionError] = useState("");
  const [serviceBlocked, setServiceBlocked] = useState(false);
  const [supportConfirmed, setSupportConfirmed] = useState(false);
  const [handsClear, setHandsClear] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const controllerActive = controllerState === "active";
  const availability = useMemo(
    () => calibrationAvailability(status, controllerActive, clock),
    [clock, controllerActive, status],
  );
  const displayCount = Math.max(status?.sampleCount ?? 0, samples.length);
  const captureAllowed = availability.captureAllowed && !serviceBlocked && handsClear;
  const beginAllowed = availability.beginAllowed && !serviceBlocked && supportConfirmed;
  const releaseAllowed = Boolean(status?.poseActive || status?.safetyFault || serviceBlocked) && supportConfirmed;

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    bridge.request({
      op: "subscribe",
      topic: JOINT4_CALIBRATION_STATUS_TOPIC,
      type: "std_msgs/msg/Float64MultiArray",
    }).then(() => {
      if (!disposed) setSubscriptionError("");
    }).catch((reason) => {
      if (!disposed) setSubscriptionError(reason instanceof Error ? reason.message : String(reason));
    });
    const unsubscribe = bridge.onMessage((message: BridgeEnvelope) => {
      if (message.op !== "topic_message" || message.topic !== JOINT4_CALIBRATION_STATUS_TOPIC) return;
      const parsed = parseJoint4CalibrationStatus(message.data);
      if (parsed) {
        setStatus(parsed);
        setClock(parsed.receivedAt);
        setSubscriptionError("");
      } else {
        setSubscriptionError("status.data 必须包含 12 个有限数值");
      }
    });
    return () => { disposed = true; unsubscribe(); };
  }, [bridge]);

  async function callService(action: CalibrationAction) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await invoke<TriggerServiceResponse>("call_joint4_calibration_service", { profile, action });
      if (!response.success) throw new Error(response.message || `${action} 被控制器拒绝`);
      setServiceBlocked(false);
      setNotice(response.message || `${action} 完成`);
      if (action === "begin_pose") {
        setSupportConfirmed(false);
        setHandsClear(false);
      } else if (action === "capture_pose" && status) {
        setSamples((current) => {
          const pose = Math.max(current.length + 1, status.sampleCount + 1);
          return [...current, sampleFromCaptureMessage(response.message, pose, status)];
        });
        setHandsClear(false);
      } else if (action === "release_pose") {
        setSupportConfirmed(false);
        setHandsClear(false);
      } else if (action === "fit") {
        setFit(parseFitResult(response.message));
      } else if (action === "reset") {
        setSamples([]);
        setFit(null);
        setHandsClear(false);
      }
    } catch (reason) {
      setServiceBlocked(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function saveReport(format: "json" | "csv") {
    const localPath = await save({
      title: `保存 joint4 标定 ${format.toUpperCase()}`,
      defaultPath: `joint4-calibration-${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`,
      filters: [{ name: format === "json" ? "JSON" : "CSV", extensions: [format] }],
    });
    if (!localPath) return;
    setBusy("save");
    setError("");
    try {
      await invoke("save_joint4_calibration_report", {
        localPath,
        content: buildCalibrationReport(samples, fit, format),
      });
      setNotice(`报告已保存：${localPath}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  const flowStep = status?.poseActive
    ? status.poseCaptured ? 4 : availability.captureAllowed ? 3 : 2
    : displayCount > 0 ? 5 : 1;
  const allBlockers = [
    ...availability.blockers,
    ...(subscriptionError ? [`状态订阅失败：${subscriptionError}`] : []),
    ...(serviceBlocked ? ["上一次服务调用失败，采样已锁定"] : []),
  ];
  const recovery = [
    ...availability.recoverySteps,
    ...(serviceBlocked ? ["保持机械臂受支撑，检查 Trigger 服务是否存在；确认后使用安全停止验证服务恢复。"] : []),
  ];

  return (
    <main className="calibration-page">
      <header className="calibration-header">
        <div><strong>Joint4 Calibration</strong><span>多姿态重力与 camera_link 负载标定</span></div>
        {pageSwitch}
        <div className="calibration-connection">
          <span className={`connection-light ${controllerActive && availability.statusFresh ? "online" : "offline"}`} />
          <strong>{controllerActive ? "Controller active" : `Controller ${controllerState ?? "未发现"}`}</strong>
          <small>{availability.statusFresh ? "status 10 Hz 正常" : "等待新鲜状态"}</small>
          <button className="ghost" onClick={onRefreshControllers}>重新检测</button>
        </div>
      </header>

      <section className="calibration-safety-banner">
        <strong>受力标定模式</strong>
        <span>保持急停可用。开始姿态前先托住机械臂；稳定阶段逐渐撤掉手部支撑，避免手力污染回归。</span>
        <button className="danger" disabled={!releaseAllowed || Boolean(busy)} onClick={() => void callService("release_pose")}>安全停止 · Release</button>
      </section>

      {(allBlockers.length > 0 || error) && (
        <section className="calibration-alert" role="alert">
          <div><strong>采样已阻止</strong>{error && <span>{error}</span>}{allBlockers.map((blocker) => <span key={blocker}>{blocker}</span>)}</div>
          {recovery.length > 0 && <ol>{[...new Set(recovery)].map((step) => <li key={step}>{step}</li>)}</ol>}
        </section>
      )}
      {notice && <div className="calibration-notice">{notice}</div>}

      <section className="calibration-flow">
        {["托住并定位", "逐渐撤掉支撑", "稳定并采样", "重新托住后释放", "移动到下一姿态"].map((label, index) => (
          <div key={label} className={flowStep === index + 1 ? "active" : flowStep > index + 1 ? "done" : ""}><i>{index + 1}</i><span>{label}</span></div>
        ))}
      </section>

      <div className="calibration-grid">
        <section className="calibration-control-card">
          <div className="calibration-card-title"><strong>姿态 {displayCount + 1}</strong><span>至少 4 个，建议 6–8 个分离姿态</span></div>
          <label className="safety-check"><input type="checkbox" checked={supportConfirmed} onChange={(event) => setSupportConfirmed(event.target.checked)} />我已托住机械臂，joint4 不会因释放或切换保持而跌落</label>
          {status?.safetyFault && !status.poseActive && <p className="fault-recovery-hint">当前姿态故障已锁存。托住确认后，Begin Pose 会在当前安全位置重建参考并清除旧版 Controller 的 fault latch。</p>}
          <button className="primary" disabled={!beginAllowed || Boolean(busy)} onClick={() => void callService("begin_pose")}>{busy === "begin_pose" ? "正在开始…" : "Begin Pose"}</button>
          <div className="withdraw-support">
            <strong>保持建立后，缓慢撤掉手部支撑</strong>
            <p>观察修正力矩、位移和速度；不要推拉机械臂。连续稳定达到 1.5 s 后才允许采样。</p>
            <label><input type="checkbox" checked={handsClear} disabled={!status?.poseActive || status.poseCaptured} onChange={(event) => setHandsClear(event.target.checked)} />手部支撑已逐渐撤掉，当前没有人为外力</label>
          </div>
          <div className="stable-meter"><span style={{ width: `${Math.min(100, ((status?.stableSeconds ?? 0) / JOINT4_CALIBRATION_LIMITS.stableDuration) * 100)}%` }} /><strong>{value(status?.stableSeconds, 2)} / 1.50 s</strong></div>
          <button className="capture" disabled={!captureAllowed || Boolean(busy)} onClick={() => void callService("capture_pose")}>{busy === "capture_pose" ? "正在采样…" : "Capture Pose"}</button>
          <p className="release-guide">采样后：再次托住机械臂并勾选上方确认，然后点击“安全停止 · Release”，再移动到下一姿态。</p>
        </section>

        <section className="calibration-status-card">
          <div className="calibration-card-title"><strong>实时状态</strong><span>{JOINT4_CALIBRATION_STATUS_TOPIC}</span></div>
          <div className="calibration-metrics">
            <div><span>q4</span><strong>{value(status?.q4)}</strong><small>rad</small></div>
            <div><span>dq4</span><strong>{value(status?.dq4)}</strong><small>rad/s</small></div>
            <div><span>URDF 重力矩</span><strong>{value(status?.modelEffort)}</strong><small>N·m</small></div>
            <div><span>软保持修正</span><strong>{value(status?.correctionEffort)}</strong><small>±1.5 N·m</small></div>
            <div><span>所需总力矩</span><strong>{value(status?.requiredEffort)}</strong><small>N·m</small></div>
            <div><span>单位质量灵敏度</span><strong>{value(status?.payloadSensitivity)}</strong><small>N·m/kg</small></div>
            <div><span>参考角</span><strong>{value(status?.poseReference)}</strong><small>rad</small></div>
            <div><span>参考位移</span><strong>{value(status ? status.q4 - status.poseReference : undefined)}</strong><small>限值 0.12 rad</small></div>
          </div>
          <div className="calibration-flags">
            <span className={status?.poseActive ? "on" : ""}>POSE ACTIVE</span>
            <span className={status?.poseCaptured ? "on" : ""}>CAPTURED</span>
            <span className={status?.safetyFault ? "fault" : ""}>SAFETY FAULT</span>
          </div>
        </section>
      </div>

      <section className="calibration-data-card">
        <div className="calibration-card-title">
          <div><strong>采样数据</strong><span>Controller {status?.sampleCount ?? 0} 个 · 本次界面记录 {samples.length} 个</span></div>
          <div className="calibration-actions">
            <button className="ghost" disabled={Boolean(busy) || Boolean(status?.poseActive) || serviceBlocked} onClick={() => void callService("reset")}>清空样本</button>
            <button className="primary" disabled={Boolean(busy) || displayCount < JOINT4_CALIBRATION_LIMITS.minimumPoses || Boolean(status?.poseActive) || serviceBlocked} onClick={() => void callService("fit")}>执行 Fit</button>
            <button className="ghost" disabled={Boolean(busy) || (samples.length === 0 && !fit)} onClick={() => void saveReport("csv")}>保存 CSV</button>
            <button className="ghost" disabled={Boolean(busy) || (samples.length === 0 && !fit)} onClick={() => void saveReport("json")}>保存 JSON</button>
          </div>
        </div>
        <div className="calibration-data-grid">
          <div className="calibration-table-wrap"><table><thead><tr><th>Pose</th><th>q4 rad</th><th>Model N·m</th><th>Required N·m</th><th>Sensitivity N·m/kg</th></tr></thead><tbody>
            {samples.map((sample) => <tr key={`${sample.pose}-${sample.capturedAt}`}><td>{sample.pose}</td><td>{value(sample.q4)}</td><td>{value(sample.modelEffort)}</td><td>{value(sample.requiredEffort)}</td><td>{value(sample.payloadSensitivity)}</td></tr>)}
            {samples.length === 0 && <tr><td colSpan={5}>尚未从本次界面采集姿态</td></tr>}
          </tbody></table></div>
          <SampleChart samples={samples} />
        </div>
      </section>

      <section className="calibration-fit-card">
        <div className="calibration-card-title"><strong>拟合结果</strong><span>仅供展示与保存，不会修改 URDF、YAML 或应用控制参数</span></div>
        {fit ? <div className="fit-results">
          <div><span>gravity_scale</span><strong>{value(fit.gravityScale, 6)}</strong></div>
          <div><span>constant_bias</span><strong>{value(fit.constantBias, 6)}</strong><small>N·m</small></div>
          <div><span>gravity_rmse</span><strong>{value(fit.gravityRmse, 6)}</strong><small>N·m</small></div>
          <div><span>equivalent_payload_mass</span><strong>{value(fit.equivalentPayloadMass, 6)}</strong><small>kg</small></div>
          <div><span>payload_bias</span><strong>{value(fit.payloadBias, 6)}</strong><small>N·m</small></div>
          <div><span>payload_rmse</span><strong>{value(fit.payloadRmse, 6)}</strong><small>N·m</small></div>
        </div> : <div className="fit-empty">采集至少 4 个具有足够重力矩跨度的姿态后执行 Fit</div>}
      </section>
    </main>
  );
}
