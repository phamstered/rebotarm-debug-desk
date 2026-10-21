import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TopicSample } from "./appLogic";
import {
  COLLECTION_FAULT11_HINT, COLLECTION_STORAGE_KEY, collectionActions, collectionArmReady, collectionConfigError,
  collectionRecordingHazardReason, collectionStampOk, collectionStartBlockedReason,
  collectionStateLabels, loadCollectionConfig,
  type CollectionAction, type CollectionConfig, type CollectionStatus,
} from "./dataCollectionLogic";
import { formatFaultCode, formatHardwareMode } from "./statusLogic";
import type { ConnectionProfile, HardwareStatus, TopicInfo } from "./types";

export function DataCollectionPage({
  profile, topics, rosReady, hardwareStatus = null, jointStateSample,
}: {
  profile: ConnectionProfile;
  topics: TopicInfo[];
  rosReady: boolean;
  hardwareStatus?: HardwareStatus | null;
  jointStateSample?: TopicSample;
}) {
  const [config, setConfig] = useState(loadCollectionConfig);
  const [status, setStatus] = useState<CollectionStatus | null>(null);
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState<CollectionAction | "">("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [discardRequested, setDiscardRequested] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sessionRef = useRef({ alive: false, busy: false });

  const run = useCallback(async (action: CollectionAction, launchConfig?: CollectionConfig) => {
    const session = sessionRef.current;
    if (!session.alive || session.busy) return;
    session.busy = true;
    setBusy(action);
    if (action !== "status") { setError(""); setDiscardRequested(false); }
    try {
      const result = await invoke<CollectionStatus>("data_collection_action", { profile, action, config: launchConfig ?? null });
      if (!session.alive) return;
      setStatus(result);
      setFresh(true);
      setPollError("");
      if (action !== "status") setNotice(result.message);
    } catch (reason) {
      if (!session.alive) return;
      setFresh(false);
      const message = reason instanceof Error ? reason.message : String(reason);
      if (action === "status") setPollError(message);
      else setError(message);
    } finally {
      session.busy = false;
      if (session.alive) setBusy("");
    }
  }, [profile]);

  useEffect(() => {
    const session = { alive: true, busy: false };
    sessionRef.current = session;
    setStatus(null); setFresh(false); setError(""); setPollError(""); setNotice(""); setBusy("");
    void run("status");
    const timer = window.setInterval(() => void run("status"), 5000);
    return () => { session.alive = false; window.clearInterval(timer); };
  }, [run]);

  useEffect(() => {
    try { localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(config)); } catch { /* storage unavailable */ }
  }, [config]);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const armReady = collectionArmReady(hardwareStatus);
  const stampOk = collectionStampOk(jointStateSample, nowMs);
  const startBlockedReason = collectionStartBlockedReason({
    hardwareStatus, jointStateSample, rosReady, nowMs,
  });
  const recordingHazard = status?.recording
    ? collectionRecordingHazardReason(hardwareStatus)
    : "";
  const validationError = collectionConfigError(config);
  const can = collectionActions(status, fresh, rosReady, armReady, stampOk, hardwareStatus?.fault_code);
  const fault11Blocked = hardwareStatus?.fault_code === 11;
  const running = Boolean(status && status.state !== "stopped");
  const update = <K extends keyof CollectionConfig>(key: K, value: CollectionConfig[K]) => setConfig((current) => ({ ...current, [key]: value }));
  const textField = (key: Exclude<keyof CollectionConfig, "fps" | "resume">, label: string, placeholder?: string, list?: string) => (
    <label>{label}<input value={config[key]} placeholder={placeholder} list={list} onChange={(event) => update(key, event.target.value)} /></label>
  );
  const stampLabel = !jointStateSample
    ? "未收到"
    : !stampOk
      ? "无效 / 过期"
      : `${jointStateSample.hz > 0 ? `${jointStateSample.hz.toFixed(1)} Hz` : "有采样"} · 时间戳可用`;

  return <section className={`collection-page${running || status?.root ? " has-session" : ""}`} aria-label="数据采集">
    <header className="collection-header">
      <div><h1>数据采集</h1><p>LeRobot v3 · 记录已有遥操作的观测与实际发送的动作</p></div>
      <button type="button" disabled={Boolean(busy)} onClick={() => { setError(""); void run("status"); }}>{busy === "status" ? "刷新中…" : "刷新状态"}</button>
    </header>
    <div className="collection-grid">
      <section className="collection-card">
        <h2>数据集配置</h2><p>文件保存在 Jetson。相对路径从远端用户主目录解析。</p>
        <fieldset disabled={running || (busy !== "" && busy !== "status")} className="collection-form">
          {textField("repoId", "数据集 ID", "namespace/dataset")}
          {textField("root", "Jetson 保存目录")}
          <label className="collection-wide">任务描述<textarea value={config.task} placeholder="例如：将红色方块放入托盘" onChange={(event) => update("task", event.target.value)} maxLength={2000} /></label>
          <label>采样频率（Hz）<input type="number" min={1} max={120} value={config.fps} onChange={(event) => update("fps", Number(event.target.value))} /></label>
          <label className="collection-checkbox"><input type="checkbox" checked={config.resume} onChange={(event) => update("resume", event.target.checked)} />续录现有数据集</label>
          {textField("wristImageTopic", "腕部 RGB Topic", undefined, "collection-image-topics")}
          {textField("baseImageTopic", "固定相机 RGB Topic（可选）", "留空表示不使用", "collection-image-topics")}
          <details className="collection-wide"><summary>数据源与运行环境</summary><div className="collection-form">
            {textField("stateTopic", "关节状态 Topic", undefined, "collection-state-topics")}
            {textField("armCommandTopic", "机械臂动作 Topic")}
            {textField("gripperCommandTopic", "夹爪动作 Topic")}
            {textField("pythonPath", "Jetson LeRobot Python 路径")}
          </div></details>
        </fieldset>
        <datalist id="collection-image-topics">{topics.filter((topic) => topic.types.includes("sensor_msgs/msg/Image")).map((topic) => <option key={topic.name} value={topic.name} />)}</datalist>
        <datalist id="collection-state-topics">{topics.filter((topic) => topic.types.includes("sensor_msgs/msg/JointState")).map((topic) => <option key={topic.name} value={topic.name} />)}</datalist>
        {!running && validationError && <p className="collection-hint">{validationError}</p>}
        <button type="button" className="collection-primary" disabled={Boolean(busy) || !can.launch || Boolean(validationError)} onClick={() => void run("launch", config)}>{busy === "launch" ? "正在启动采集器…" : "启动采集器"}</button>
        <p className="collection-hint">先在 Status 启动 Teleop（含夹爪）和相机。关节状态应使用含夹爪米制位置的 /joint_states；腕部图像为 RGB。续录须保持相机、分辨率、FPS 和状态/动作布局一致。</p>
      </section>
      <section className="collection-card collection-session">
        <div className="collection-card-title"><h2>Episode</h2><span className={`collection-state ${status?.recording ? "recording" : ""}`}>{!fresh ? "状态待确认" : status ? collectionStateLabels[status.state] : "检测中"}</span></div>
        <div className="collection-metrics">
          <div><strong>{fresh ? status?.pendingFrames ?? "—" : "—"}</strong><span>当前帧数</span></div>
          <div><strong>{fresh ? status?.savedEpisodes ?? "—" : "—"}</strong><span>已保存 Episode</span></div>
          <div><strong>{fresh && status?.fps ? status.fps : "—"}</strong><span>采样 Hz</span></div>
        </div>
        <dl className="collection-details collection-arm-status" aria-label="机械臂与时间戳">
          <div><dt>模式</dt><dd>{formatHardwareMode(hardwareStatus)}</dd></div>
          <div><dt>fault</dt><dd>{formatFaultCode(hardwareStatus?.fault_code)}</dd></div>
          <div><dt>seq</dt><dd>{hardwareStatus?.last_command_sequence != null ? String(hardwareStatus.last_command_sequence) : "—"}</dd></div>
          <div><dt>时间戳</dt><dd>{stampLabel}</dd></div>
        </dl>
        {(running || status?.root) && <dl className="collection-details">
          <div><dt>数据集</dt><dd>{status?.repoId || "外部启动（ID 未提供）"}</dd></div>
          <div><dt>目录</dt><dd>{status?.root || "外部启动（目录未提供）"}</dd></div>
          <div><dt>任务</dt><dd>{status?.task || "—"}</dd></div>
          <div><dt>进程</dt><dd>{!running ? "已退出" : status?.managed ? `本应用启动 · PID ${status.pid}` : "外部启动 · 可操作 Episode，结束请回原终端"}</dd></div>
        </dl>}
        {recordingHazard && <div className="collection-danger-banner" role="alert">{recordingHazard} 请点击「丢弃 Episode」（不会自动丢弃）。</div>}
        <div className="collection-actions">
          <button type="button" className="collection-primary" disabled={Boolean(busy) || !can.start} onClick={() => void run("start_episode")} title={startBlockedReason || undefined}>开始 Episode</button>
          <button type="button" disabled={Boolean(busy) || !can.save} onClick={() => void run("save_episode")}>保存成功 Episode</button>
          <button type="button" className="collection-danger" disabled={Boolean(busy) || !can.discard} onClick={() => setDiscardRequested(true)}>丢弃 Episode</button>
          <button type="button" disabled={Boolean(busy) || !can.finish} onClick={() => void run("finish")}>{busy === "finish" ? "正在完成数据集…" : "结束并完成数据集"}</button>
        </div>
        {busy && busy !== "status" && <p className="collection-notice" role="status">{({ launch: "正在启动采集器…", start_episode: "正在开始 Episode…", save_episode: "正在保存 Episode，请等待写入完成…", discard_episode: "正在丢弃 Episode…", finish: "正在完成数据集，请等待编码与元数据收尾…" })[busy]}</p>}
        {discardRequested && <div className="collection-confirm" role="alert">丢弃当前 Episode 的未保存帧？已保存 Episode 会保留。<div><button type="button" disabled={Boolean(busy) || !can.discard} onClick={() => void run("discard_episode")}>确认丢弃</button><button type="button" onClick={() => setDiscardRequested(false)}>取消</button></div></div>}
        {fault11Blocked && <p className="collection-hint" role="alert">{COLLECTION_FAULT11_HINT}</p>}
        {!can.start && startBlockedReason && status?.state === "idle" && fresh && <p className="collection-hint" role="status">{startBlockedReason}</p>}
        {status?.recording && status.pendingFrames === 0 && <p className="collection-hint">尚未写入有效帧；请检查 Topic、数据新鲜度及日志。</p>}
        {notice && <output className="collection-notice">{notice}</output>}
        {(error || pollError) && <pre className="collection-error" role="alert">{error || pollError}</pre>}
        <p className="collection-hint">每 5 秒刷新。采集中请勿重置场景；保存或丢弃后再复位物体。切换页面或断开连接后，Jetson 上的采集器仍继续运行。退出前请先保存或丢弃，再完成数据集。</p>
        <details open className="collection-logs"><summary>采集器日志</summary><pre>{status?.log || "暂无日志"}</pre></details>
      </section>
    </div>
  </section>;
}
