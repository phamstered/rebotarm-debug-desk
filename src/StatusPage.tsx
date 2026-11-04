import { controllerStatusFresh } from "./controllersInfoLogic";
import type { ClockSyncStatus as ClockStatus } from "./clockSyncLogic";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentServiceStatus,
  ArmModeStatus,
  ConnectionProfile,
  HardwareStatus,
  RosControlStatus,
  UsbProbeStatus,
} from "./types";
import type { TopicSample } from "./appLogic";
import { isRosReady } from "./appLogic";
import {
  buildHardwareStickyAlert,
  buildStatusCards,
  buildStatusQuickActions,
  groupStatusZones,
  resolveActiveControlMode,
  toneLabel,
  statusZoneForCard,
  summarizeStatusZone,
  type StatusZoneId,
  type BridgeHelloInfo,
  type StatusCardAction,
  type StatusCardModel,
  type StatusTone,
} from "./statusLogic";
import { ControlLogViewer } from "./ControlLogViewer";
import { ArmModeWorkflow } from "./ArmModeWorkflow";
import type { ArmWorkflow } from "./armModeWorkflowLogic";
import { isArmTeleopControllerActive, isArmTrajectoryControllerActive, isVlaControllerActive } from "./vlaLogic";

function ToneBadge({ tone }: { tone: StatusTone }) {
  return <span className={`status-card-tone ${tone}`}>{toneLabel(tone)}</span>;
}

function StatusCard({
  card,
  highlighted,
  onAction,
  compact,
}: {
  card: StatusCardModel;
  highlighted: boolean;
  onAction?: (action: StatusCardAction, card: StatusCardModel) => void;
  compact?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  return (
    <article
      ref={ref}
      id={`status-card-${card.id}`}
      className={`status-card tone-${card.tone}${highlighted ? " highlighted" : ""}${compact ? " compact" : ""}`}
      aria-label={card.title}
      data-highlighted={highlighted ? "true" : undefined}
    >
      <header className="status-card-header">
        <div>
          <h2>{card.title}</h2>
          <p>{card.summary}</p>
        </div>
        <ToneBadge tone={card.tone} />
      </header>
      {card.detail && <p className="status-card-detail" data-testid={`status-detail-${card.id}`}>{card.detail}</p>}
      {card.failureReason && (
        <p className="status-card-failure" role="alert" data-testid={`status-failure-${card.id}`}>
          {card.failureReason}
        </p>
      )}
      <dl className="status-card-rows">
        {card.rows.map((row) => (
          <div key={row.label} className="status-card-row">
            <dt>{row.label}</dt>
            <dd className={row.tone ? `tone-${row.tone}` : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {card.warning && (
        <p className="status-card-warning" role="note" data-testid={`status-warning-${card.id}`}>
          {card.warning}
        </p>
      )}
      {card.note && <p className="status-card-note">{card.note}</p>}
      {card.actions && card.actions.length > 0 && (
        <div className="status-card-actions" aria-label={`${card.title} 操作`}>
          {card.actions.map((action) => (
            <div key={action.id} className="status-card-action-wrap">
              <button
                type="button"
                className={`status-card-action ${action.kind}`}
                disabled={action.disabled}
                title={action.disabledReason || action.label}
                onClick={() => onAction?.(action, card)}
              >
                {action.label}
              </button>
              {action.disabled && action.disabledReason && (
                <p className="status-disabled-hint" data-testid={`status-disabled-${card.id}-${action.id}`}>
                  {action.disabledReason}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function StatusPage({
  clockSync,
  stage,
  sshOk,
  bridgeUp,
  localPort,
  profile,
  hello,
  agentStatus,
  agentError,
  agentChecked,
  hardwareStatus,
  jointState,
  jointStateSample,
  rosControl,
  lastKnownDomainId,
  highlightCardId = null,
  usbProbe = null,
  usbChecked = false,
  armMode = null,
  realsenseTopicSample,
  vlaChunkSample,
  actionBusy = null,
  actionNotice = "",
  workflow = null,
  onCardAction,
  onQuickAction,
  onSaveTeachingPose,
  onClearHighlight,
}: {
  clockSync?: ClockStatus;
  stage: string;
  sshOk: boolean;
  bridgeUp: boolean;
  localPort: number | null;
  profile: ConnectionProfile;
  hello: BridgeHelloInfo | null;
  agentStatus: AgentServiceStatus | null;
  agentError: string;
  agentChecked: boolean;
  hardwareStatus: HardwareStatus | null;
  jointState: unknown;
  jointStateSample: TopicSample | undefined;
  rosControl: RosControlStatus | null;
  lastKnownDomainId: number | null;
  highlightCardId?: string | null;
  usbProbe?: UsbProbeStatus | null;
  usbChecked?: boolean;
  armMode?: ArmModeStatus | null;
  realsenseTopicSample?: TopicSample | undefined;
  vlaChunkSample?: TopicSample | undefined;
  actionBusy?: string | null;
  actionNotice?: string;
  workflow?: ArmWorkflow | null;
  onClearHighlight?: () => void;
  onCardAction?: (action: StatusCardAction, card: StatusCardModel) => void;
  onSaveTeachingPose?: () => void;
  onQuickAction?: (id: "teleop" | "trajectory" | "vla" | "teaching" | "stop" | "disable-stop") => void;
}) {
  const [selectedTab, setSelectedTab] = useState<StatusZoneId>(() => statusZoneForCard(highlightCardId) ?? "connection");
  useEffect(() => {
    const zone = statusZoneForCard(highlightCardId);
    if (zone) setSelectedTab(zone);
  }, [highlightCardId]);
  const selectTab = (id: StatusZoneId) => { setSelectedTab(id); onClearHighlight?.(); };
  const [confirmTeaching, setConfirmTeaching] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [supported, setSupported] = useState(false);
  useEffect(() => { setConfirmTeaching(false); setConfirmDisable(false); setSupported(false); }, [stage, profile.host, profile.rosDomainId, profile.rosSetupScript]);
  const controlStopped = Boolean(workflow && ["stop", "disable-stop"].includes(workflow.mode) && workflow.stage === "ready" && !workflow.failed && hardwareStatus?.mode === 3 && hardwareStatus?.fault_code === 0);
  const cards = buildStatusCards({
    clockSync,
    controlStopped,
    stage,
    sshOk,
    bridgeUp,
    localPort,
    remotePort: profile.remotePort,
    profile,
    hello,
    agentStatus,
    agentError,
    agentChecked,
    hardwareStatus,
    jointState,
    jointStateSample,
    jointStateTopic: profile.jointStateTopic,
    rosControl,
    lastKnownDomainId,
    usbProbe,
    usbChecked,
    armMode,
    realsenseTopicSample,
    vlaChunkSample,
    actionBusy,
  });
  const zones = useMemo(() => groupStatusZones(cards), [cards]);
  const stickyAlert = useMemo(() => buildHardwareStickyAlert(hardwareStatus), [hardwareStatus]);
  const observedMode = useMemo(
    () => resolveActiveControlMode({ armMode, rosControl }),
    [armMode, rosControl],
  );
  const activeMode = controlStopped ? null : observedMode;
  useEffect(() => { }, [activeMode, hardwareStatus?.mode, hardwareStatus?.fault_code]);
  const modeConfirmed = controllerStatusFresh(rosControl) || controlStopped;
  const [targetMode, setTargetMode] = useState<"teleop" | "trajectory" | "vla" | "teaching">("teleop");
  useEffect(() => { if (modeConfirmed && activeMode) setTargetMode(activeMode); }, [activeMode, modeConfirmed]);
  const modeNames = { teleop: "Teleop", trajectory: "Trajectory", vla: "VLA", teaching: "拖动示教" };
  const disabledSession = Boolean(activeMode && hardwareStatus?.mode === 3);
  const returningSession = Boolean(activeMode && hardwareStatus?.mode === 2);
  const modeConflict = !controlStopped && [isArmTeleopControllerActive(rosControl), isArmTrajectoryControllerActive(rosControl), isVlaControllerActive(rosControl)].filter(Boolean).length > 1;
  const quickActions = buildStatusQuickActions({
    sshOk,
    rosReady: isRosReady(jointState),
    actionBusy,
    vlaActive: isVlaControllerActive(rosControl),
    hardwareStatus,
  });

  const targetAction = quickActions.find((action) => action.id === targetMode)!;
  const logMode = workflow && (workflow.running || workflow.failed || actionBusy) && ["teleop", "trajectory", "vla", "teaching"].includes(workflow.mode) ? workflow.mode : (modeConfirmed ? activeMode : null) ?? targetMode;
  const logSource = workflow?.mode === "moveit" || (workflow?.mode === "trajectory" && workflow.stage === "planner") ? "moveit" : logMode === "teaching" ? "teaching" : logMode === "vla" ? "vla" : logMode === "trajectory" ? "trajectory" : "teleop";
  return (
    <main className="status-page">
      <header className="status-page-header">
        <div>
          <h1>Status</h1>
          <span>分区状态总览 · 控制模式与实时日志</span>
        </div>
        <div className="status-page-meta" title="不刷写固件；Bridge 升级仍走既有 mismatch 提示">
          <span>NO FLASH</span>
          <strong>{profile.name || profile.host}</strong>
        </div>
      </header>
      <p className="status-page-banner" role="note">
        选择控制模式后确认启动或切换。切换前会安全停止、关闭输出并清理旧控制进程；拖动示教退出需先支撑，不主动回零；失败时停止切换，详情见下方日志。
      </p>
      {stickyAlert && (
        <div
          className={`status-sticky-alert tone-${stickyAlert.tone}`}
          role="alert"
          data-testid="status-sticky-alert"
          data-kind={stickyAlert.kind}
        >
          <strong>{stickyAlert.title}</strong>
          <span>{stickyAlert.message}</span>
        </div>
      )}
      <div className="status-tabs" role="tablist" aria-label="状态分区">
        {zones.map((zone, index) => {
          const summary = summarizeStatusZone(zone.cards);
          return <button key={zone.id} type="button" role="tab" id={`status-tab-${zone.id}`}
            aria-controls={`status-panel-${zone.id}`} aria-selected={selectedTab === zone.id}
            tabIndex={selectedTab === zone.id ? 0 : -1} className={`status-tab tone-${summary.tone}`}
            title={summary.detail} onClick={() => selectTab(zone.id)} onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % zones.length : event.key === "ArrowLeft" ? (index + zones.length - 1) % zones.length : event.key === "Home" ? 0 : event.key === "End" ? zones.length - 1 : -1;
              if (next < 0) return;
              event.preventDefault();
              selectTab(zones[next].id);
              document.getElementById(`status-tab-${zones[next].id}`)?.focus();
            }}>
            <span className="status-tab-name">{zone.title}</span>
            <ToneBadge tone={summary.tone} />
            <span className="status-tab-summary">{summary.detail}</span>
          </button>;
        })}
      </div>
      <div className="status-zones">
        {zones.map((zone) => {
          const isControl = zone.id === "control";
          const zoneCards = isControl
            ? zone.cards.filter((card) => card.id === activeMode || card.id === "ros2-control" || card.id === "ros-ready")
            : zone.cards;
          const body = (
            <>
              {isControl && (
                <section className="status-mode-strip" aria-label="控制模式启停">
                  <header className="status-mode-current" aria-live="polite">
                    <span>当前模式</span>
                    <strong data-testid="current-control-mode">{!modeConfirmed ? "待确认" : modeConflict ? "控制器状态冲突" : activeMode ? `${modeNames[activeMode]}${disabledSession ? "（输出已关闭）" : returningSession ? "（回零中）" : ""}` : "未启用控制"}</strong>
                    <span>{actionBusy ? "正在执行模式操作，等待核验结果" : returningSession ? "等待回零及 DISABLE 确认，尚不能启用目标模式" : disabledSession ? "下位机输出已关闭，旧控制会话需要重建" : activeMode && modeConfirmed ? "控制器已激活" : "以控制器实时状态为准"}</span>
                  </header>
                  <div className="status-mode-selection">
                    <span>选择目标模式</span>
                    <div className="status-mode-segment" role="group" aria-label="选择目标模式">
                      {quickActions.filter((action) => action.id === "teleop" || action.id === "trajectory" || action.id === "vla" || action.id === "teaching").map((action) => (
                        <button key={action.id} type="button" className={`status-quick-action${targetMode === action.id ? " active" : ""}`}
                          disabled={action.disabled} aria-pressed={targetMode === action.id}
                          title={action.disabledReason || action.label}
                          onClick={() => setTargetMode(action.id as typeof targetMode)}>{action.label}</button>
                      ))}
                    </div>
                    <button type="button" className="status-quick-action primary" disabled={targetAction.disabled || activeMode === "teaching" || returningSession || (modeConfirmed && !modeConflict && !disabledSession && activeMode === targetMode)}
                      onClick={() => { if (targetMode === "teaching") { setSupported(false); setConfirmTeaching(true); } else onQuickAction?.(targetMode); }}>{actionBusy ? "切换中…" : activeMode === "teaching" ? "请先支撑并退出示教" : returningSession ? "等待回零完成" : disabledSession ? "重建控制会话" : activeMode === targetMode && modeConfirmed && !modeConflict ? "当前模式已启用" : activeMode ? "切换模式（先回零）" : "启动所选模式"}</button>
                    {targetAction.disabledReason && <p className="status-disabled-hint" data-testid="status-mode-disabled">{targetAction.disabledReason}</p>}
                  </div>
                  <p className="status-mode-explanation">目标：{modeNames[targetMode]} · {activeMode === "teaching" ? "退出示教前先支撑机械臂与物体，解除输出后再切换。" : "切换流程：安全停止旧模式 → 清理旧进程 → 启动并核验。"}</p>
                  <div className="status-mode-stops">
                    <div><button type="button" className="status-quick-action stop" disabled={quickActions.find((a) => a.id === "stop")?.disabled}
                      onClick={() => { if (activeMode === "teaching" || armMode?.teachingRunning) { setSupported(false); setConfirmDisable(true); } else onQuickAction?.("stop"); }}>{activeMode === "teaching" || armMode?.teachingRunning ? "支撑并退出示教" : "回零并退出控制"}</button>
                      <p>{activeMode === "teaching" || armMode?.teachingRunning ? "不会主动回零；确认支撑后关闭输出。" : "回到零位，确认输出关闭后退出。不是暂停或保持。"}</p></div>
                    <details><summary>直接关闭输出…</summary>
                      <p>不回零，机械臂与夹爪会失去电机输出；先在现场支撑。</p>
                      <button type="button" className="status-quick-action disable-stop" disabled={quickActions.find((a) => a.id === "disable-stop")?.disabled}
                        onClick={() => { setSupported(false); setConfirmDisable(true); }}>直接解除电机输出</button>
                    </details>
                  </div>
                  {actionNotice && <output className="status-action-notice" role="status">{actionNotice}</output>}
                  {activeMode === "teaching" && <section className="teaching-gripper" aria-label="手动示教">
                    <strong>六轴与夹爪手动示教</strong>
                    <p>六轴保留重力补偿与阻尼；夹爪不主动保持位置，可用手拨动。请托住夹爪中的物体。</p>
                    <div className="teaching-gripper-actions">
                      <button disabled={Boolean(actionBusy) || !modeConfirmed || !onSaveTeachingPose} onClick={onSaveTeachingPose}>保存当前姿态</button>
                    </div>
                    <p>保存同一帧的六轴与夹爪实测姿态，可在 Motion 姿态库查看；松手不保证机械臂保持原位。</p>
                  </section>}
                  <ArmModeWorkflow workflow={workflow} />
                </section>
              )}
              {isControl && !activeMode && (
                <p className="status-mode-idle" data-testid="status-mode-idle">{modeConfirmed ? "当前无运行中模式 · 选择目标模式后点击启动" : "当前模式待确认 · 可刷新状态或尝试恢复启动"}</p>
              )}
              <div
                className={`status-card-grid zone-${zone.id}${zone.primary ? " primary" : ""}`}
                aria-label={`${zone.title} 卡片`}
              >
                {zoneCards.map((card) => (
                  <StatusCard
                    key={card.id}
                    card={card}
                    highlighted={highlightCardId === card.id && selectedTab === zone.id}
                    onAction={onCardAction}
                    compact={zone.id === "connection"}
                  />
                ))}
              </div>
            </>
          );

          return (
            <section
              key={zone.id}
              className={`status-zone zone-${zone.id}${zone.primary ? " primary" : ""}`}
              role="tabpanel" id={`status-panel-${zone.id}`} aria-labelledby={`status-tab-${zone.id}`}
              hidden={selectedTab !== zone.id}
              data-primary={zone.primary ? "true" : undefined}
            >
              <header className="status-zone-title">
                <h2>{zone.title}</h2>
                {zone.primary && <span className="status-zone-badge">主区</span>}
              </header>
              {body}
              {isControl && <ControlLogViewer key={logSource} profile={profile} connected={sshOk} active={selectedTab === "control"}
                preferredSource={logSource} />}
            </section>
          );
        })}
      </div>
      {confirmTeaching && <div className="modal-backdrop"><section className="toolbar-modal" role="dialog" aria-modal="true" aria-label="拖动示教确认">
        <header className="toolbar-modal-title"><strong>进入拖动示教</strong></header>
        <div className="toolbar-modal-content"><p>先按原模式安全停止，再启用六轴零位置刚度、阻尼与重力补偿。机械臂可能因模型误差或负载变化漂移；夹爪释放主动保持，可用手拨动；请托住夹爪中的物体。</p>
          <label className="safety-check"><input type="checkbox" checked={supported} onChange={(e) => setSupported(e.target.checked)} />已支撑机械臂与物体，运动区域安全，允许切换为柔顺模式</label></div>
        <footer className="toolbar-modal-actions"><button onClick={() => setConfirmTeaching(false)}>取消</button><button disabled={!supported || Boolean(actionBusy)} onClick={() => { setConfirmTeaching(false); onQuickAction?.("teaching"); }}>确认进入拖动示教</button></footer>
      </section></div>}
      {confirmDisable && <div className="modal-backdrop">
        <section className="toolbar-modal" role="dialog" aria-modal="true" aria-label="解除电机输出确认">
          <header className="toolbar-modal-title"><strong>解除电机输出并停止</strong></header>
          <div className="toolbar-modal-content">
            <p>DISABLE 会解除机械臂与夹爪的电机输出。请先在现场支撑机械臂，确认夹爪释放无风险。此操作不会清除 STM32 锁存故障。</p>
            <label className="safety-check"><input type="checkbox" checked={supported} onChange={(event) => setSupported(event.target.checked)} />机械臂已支撑，可以解除输出</label>
          </div>
          <footer className="toolbar-modal-actions">
            <button type="button" onClick={() => setConfirmDisable(false)}>取消</button>
            <button type="button" disabled={!supported || Boolean(actionBusy)} onClick={() => { setConfirmDisable(false); onQuickAction?.("disable-stop"); }}>确认 DISABLE 并停止</button>
          </footer>
        </section>
      </div>}
    </main>
  );
}
