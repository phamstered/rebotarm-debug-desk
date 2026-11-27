import { ControlNoticeBar } from "./ControlNoticeBar";
import { useTerminalMessage } from "./terminalLogLogic";
import { workflowSteps } from "./armModeWorkflowLogic";
import { useControllerManager } from "./controllerManagerLogic";
import { reconcileControlState, controlTaskReason } from "./controlStateLogic";
import { useNativeTaskSnapshot } from "./nativeTaskSnapshotLogic";
import { nativeDesktop } from "./nativeWorkspaceLogic";
import { ActionButton, IconButton } from "./ActionButton";
import { NativePageActions } from "./NativePageActions";
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
import { ControlPageGuidance } from "./ControlPageGuidance";
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
  diagnosticsInTerminal,
}: {
  card: StatusCardModel;
  highlighted: boolean;
  onAction?: (action: StatusCardAction, card: StatusCardModel) => void;
  compact?: boolean;
  diagnosticsInTerminal?: boolean;
}) {
  useTerminalMessage("Controller",diagnosticsInTerminal ? card.failureReason : "","error");
  useTerminalMessage("Controller",diagnosticsInTerminal ? card.detail : "");
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
      {card.detail && !diagnosticsInTerminal && <p className="status-card-detail" data-testid={`status-detail-${card.id}`}>{card.detail}</p>}
      {card.failureReason && !diagnosticsInTerminal && (
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
      {card.warning && !diagnosticsInTerminal && (
        <p className="status-card-warning" role="note" data-testid={`status-warning-${card.id}`}>
          {card.warning}
        </p>
      )}
      {card.note && <p className="status-card-note">{card.note}</p>}
      {card.actions && card.actions.length > 0 && (
        <div className="status-card-actions" aria-label={`${card.title} 操作`}>
          {card.actions.map((action) => (
            <div key={action.id} className="status-card-action-wrap">
              {action.kind === "refresh" ? <IconButton icon="refresh" label={action.label}
                disabled={action.disabled} title={action.disabledReason || action.label}
                onClick={() => onAction?.(action, card)} /> : <ActionButton
                type="button"
                className={`status-card-action ${action.kind}`}
                disabled={action.disabled}
                title={action.disabledReason || action.label}
                onClick={() => onAction?.(action, card)}
              >
                {action.label}
              </ActionButton>}
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
  controlView = false, controlActive = true, renderControl, onManageControllers,
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
  workflow = null,
  onCardAction,
  onQuickAction,
  onSaveTeachingPose,
  onClearHighlight,
}: {
  controlView?: boolean;
  controlActive?: boolean;
  renderControl?: (presets: import("react").ReactNode, manager: ReturnType<typeof useControllerManager>, stateReason: string, notices: string[]) => import("react").ReactNode;
  onManageControllers?: () => void;
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
  const managedView = controlView && Boolean(renderControl);
  const manager = useControllerManager(profile, stage === "connected" && managedView, managedView && controlActive);
  useEffect(() => {
    if (managedView && controlActive && !actionBusy) void manager.refresh("background");
  }, [managedView, controlActive, actionBusy, workflow?.stage]);
  const sharedTask = useNativeTaskSnapshot(controlView && nativeDesktop());
  const reconciled = reconcileControlState(manager.snapshot, manager.fresh, rosControl);
  const observationReason = managedView ? reconciled.reason : "";
  const taskReason = sharedTask.error || (!sharedTask.loaded ? "正在核验共享任务状态" : controlTaskReason(sharedTask.task));
  const modeBlock = taskReason || observationReason;
  const [selectedTab, setSelectedTab] = useState<StatusZoneId>(() => controlView ? "control" : statusZoneForCard(highlightCardId) ?? "connection");
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
  const zones = useMemo(() => groupStatusZones(cards).filter(zone => !controlView || zone.id === "control"), [cards, controlView]);
  const stickyAlert = useMemo(() => buildHardwareStickyAlert(hardwareStatus), [hardwareStatus]);
  const observedMode = useMemo(
    () => resolveActiveControlMode({ armMode, rosControl }),
    [armMode, rosControl],
  );
  const activeMode = controlStopped || (managedView && (reconciled.state === "offline" || !reconciled.modeKnown)) ? null : observedMode;
  const presetEnvironment = activeMode === "teaching" ? Boolean(armMode?.teachingRunning) :
    activeMode === "teleop" ? Boolean(armMode?.teleopRunning && armMode.teleopOwnsRos2Control) :
    activeMode === "trajectory" || activeMode === "vla" ? Boolean(armMode?.trajectoryRunning && armMode.trajectoryOwnsRos2Control) : false;
  const presetConfirmed = presetEnvironment && Boolean(rosControl?.controllers.some(c=>c.name === "gravity_compensation_controller" && c.state === "active"));
  const customCombination = (!managedView || reconciled.state === "ready") && controllerStatusFresh(rosControl) && !presetConfirmed && rosControl!.controllers.some(c=>c.state === "active") && !controlStopped;
  useEffect(() => { }, [activeMode, hardwareStatus?.mode, hardwareStatus?.fault_code]);
  const modeConfirmed = managedView ? reconciled.modeKnown : controllerStatusFresh(rosControl) || controlStopped;
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
  const controlNotices = controlView ? [...new Set([
    stickyAlert && `${stickyAlert.title}：${stickyAlert.message}`,
    modeBlock, targetAction.disabledReason,
    workflow?.failed ? "控制操作失败，详细原因见底部 Terminal" : workflow?.running ? `正在执行：${workflowSteps(workflow.mode).find(step=>step.id===workflow.stage)?.label ?? "控制操作"}` : "",
    returningSession ? "等待回零及 DISABLE 确认" : disabledSession ? "旧控制会话需要重建" : "",
    ...cards.filter(card=>[activeMode,"ros2-control","ros-ready"].includes(card.id)).flatMap(card=>[card.failureReason ? `${card.title} 异常，详细原因见底部 Terminal` : "",card.warning]),
  ].filter((value):value is string=>Boolean(value)))] : [];
  const content = (
    <main className="status-page">
      {controlView && !managedView && <ControlNoticeBar messages={controlNotices}/> }
      {!controlView && <header className="status-page-header native-window-header">
        <div>
          <h1>Status</h1>
          <span>连接、硬件与控制环境总览</span>
        </div>
        <div className="status-page-meta" title="不刷写固件；Bridge 升级仍走既有 mismatch 提示">
          <span>NO FLASH</span>
          <strong>{profile.name || profile.host}</strong>
        </div>
        <NativePageActions />
      </header>}
      {!controlView && <p className="status-page-banner" role="note">
        控制环境启停与 Controller 管理位于「控制模式」，操作日志统一显示在底部 Terminal。
        <ActionButton onClick={onManageControllers}>打开控制模式</ActionButton>
      </p>}
      {!controlView && stickyAlert && (
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
      {!controlView && <div className="status-tabs" role="tablist" aria-label="状态分区">
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
      </div>}
      {controlView && !managedView && <ControlPageGuidance />}
      <div className="status-zones">
        {zones.map((zone) => {
          const isControl = zone.id === "control";
          const zoneCards = isControl
            ? zone.cards.filter((card) => card.id === activeMode || card.id === "ros2-control" || card.id === "ros-ready")
            : zone.cards;
          const body = (
            <>
              {isControl && controlView && (
                <section className="status-mode-strip" aria-label="控制模式启停">
                  <header className="status-mode-current" aria-live="polite">
                    <span>当前模式</span>
                    <strong data-testid="current-control-mode">{!modeConfirmed ? (managedView && reconciled.state === "conflict" ? "状态不一致 · 待核验" : "待确认") : modeConflict ? "控制器状态冲突" : customCombination ? `自定义组合${disabledSession ? "（输出已关闭）" : returningSession ? "（回零中）" : ""}` : activeMode ? `${modeNames[activeMode]}${disabledSession ? "（输出已关闭）" : returningSession ? "（回零中）" : ""}` : "未启用控制"}</strong>

                  </header>
                  <div className="status-mode-selection">
                    <span>选择目标模式 · {modeNames[targetMode]}</span>
                    <div className="status-mode-segment" role="group" aria-label="选择目标模式">
                      {quickActions.filter((action) => action.id === "teleop" || action.id === "trajectory" || action.id === "vla" || action.id === "teaching").map((action) => (
                        <button key={action.id} type="button" className={`status-quick-action${targetMode === action.id ? " active" : ""}`}
                          disabled={action.disabled} aria-pressed={targetMode === action.id}
                          title={action.disabledReason || action.label}
                          onClick={() => setTargetMode(action.id as typeof targetMode)}>{action.label}{controlView && <small aria-hidden="true">{{teleop:"主臂跟随与重力补偿",trajectory:"轨迹执行与 MoveIt 规划",teaching:"手动拖动、阻尼与重力补偿",vla:"策略推理驱动的关节目标"}[action.id as "teleop"|"trajectory"|"teaching"|"vla"]}</small>}</button>
                      ))}
                    </div>
                    <ActionButton type="button" className="status-quick-action primary" title={modeBlock || undefined} disabled={Boolean(modeBlock) || targetAction.disabled || activeMode === "teaching" || returningSession || (modeConfirmed && !modeConflict && !disabledSession && presetConfirmed && activeMode === targetMode)}
                      onClick={() => { if (targetMode === "teaching") { setSupported(false); setConfirmTeaching(true); } else onQuickAction?.(targetMode); }}>{modeBlock ? "等待状态核验" : actionBusy ? "切换中…" : activeMode === "teaching" ? "请先支撑并退出示教" : returningSession ? "等待回零完成" : disabledSession ? "重建控制会话" : presetConfirmed && activeMode === targetMode && modeConfirmed && !modeConflict ? "当前模式已启用" : activeMode ? "切换模式（先回零）" : "启动所选模式"}</ActionButton>

                  </div>
                  <div className="status-mode-stops">
                    <div><ActionButton type="button" className="status-quick-action stop" disabled={quickActions.find((a) => a.id === "stop")?.disabled}
                      onClick={() => { if (activeMode === "teaching" || armMode?.teachingRunning) { setSupported(false); setConfirmDisable(true); } else onQuickAction?.("stop"); }}>{activeMode === "teaching" || armMode?.teachingRunning ? "支撑并退出示教" : "回零并退出控制"}</ActionButton>
                      <p>{activeMode === "teaching" || armMode?.teachingRunning ? "先现场支撑，关闭输出后退出。" : "回零后关闭输出并退出。"}</p></div>
                    <details open={Boolean(sharedTask.task && ["stopping", "uncertain"].includes(sharedTask.task.phase))}><summary>直接关闭输出…</summary>
                      <p>不回零，机械臂与夹爪会失去电机输出；先在现场支撑。</p>
                      <ActionButton type="button" className="status-quick-action disable-stop" disabled={quickActions.find((a) => a.id === "disable-stop")?.disabled}
                        onClick={() => { setSupported(false); setConfirmDisable(true); }}>直接解除电机输出</ActionButton>
                    </details>
                  </div>
                  {activeMode === "teaching" && <section className="teaching-gripper" aria-label="手动示教">
                    <strong>六轴与夹爪手动示教</strong>
                    <p>六轴保留重力补偿与阻尼；夹爪不主动保持位置，可用手拨动。请托住夹爪中的物体。</p>
                    <div className="teaching-gripper-actions">
                      <ActionButton disabled={Boolean(actionBusy) || !modeConfirmed || !onSaveTeachingPose} onClick={onSaveTeachingPose}>保存当前姿态</ActionButton>
                    </div>
                    <p>保存同一帧的六轴与夹爪实测姿态，可在 Motion 姿态库查看；松手不保证机械臂保持原位。</p>
                  </section>}
                  <ArmModeWorkflow workflow={workflow} logOnly />
                </section>
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
                    onAction={isControl && !controlView ? () => onManageControllers?.() : onCardAction}
                    diagnosticsInTerminal={controlView}
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
              role="tabpanel" id={`status-panel-${zone.id}`} aria-label={controlView ? "模式预设" : undefined} aria-labelledby={controlView ? undefined : `status-tab-${zone.id}`}
              hidden={!controlView && selectedTab !== zone.id}
              data-primary={zone.primary ? "true" : undefined}
            >
              <header className="status-zone-title">
                <h2>{zone.title}</h2>
                {zone.primary && <span className="status-zone-badge">主区</span>}
              </header>
              {body}
            </section>
          );
        })}
      </div>
      {confirmTeaching && <div className="modal-backdrop"><section className="toolbar-modal" role="dialog" aria-modal="true" aria-label="拖动示教确认">
        <header className="toolbar-modal-title"><strong>进入拖动示教</strong></header>
        <div className="toolbar-modal-content"><p>先按原模式安全停止，再启用六轴零位置刚度、阻尼与重力补偿。机械臂可能因模型误差或负载变化漂移；夹爪释放主动保持，可用手拨动；请托住夹爪中的物体。</p>
          <label className="safety-check"><input type="checkbox" checked={supported} onChange={(e) => setSupported(e.target.checked)} />已支撑机械臂与物体，运动区域安全，允许切换为柔顺模式</label></div>
        <footer className="toolbar-modal-actions"><ActionButton onClick={() => setConfirmTeaching(false)}>取消</ActionButton><ActionButton disabled={!supported || Boolean(actionBusy) || Boolean(modeBlock)} onClick={() => { setConfirmTeaching(false); onQuickAction?.("teaching"); }}>确认进入拖动示教</ActionButton></footer>
      </section></div>}
      {confirmDisable && <div className="modal-backdrop">
        <section className="toolbar-modal" role="dialog" aria-modal="true" aria-label="解除电机输出确认">
          <header className="toolbar-modal-title"><strong>解除电机输出并停止</strong></header>
          <div className="toolbar-modal-content">
            <p>DISABLE 会解除机械臂与夹爪的电机输出。请先在现场支撑机械臂，确认夹爪释放无风险。此操作不会清除 STM32 锁存故障。</p>
            <label className="safety-check"><input type="checkbox" checked={supported} onChange={(event) => setSupported(event.target.checked)} />机械臂已支撑，可以解除输出</label>
          </div>
          <footer className="toolbar-modal-actions">
            <ActionButton type="button" onClick={() => setConfirmDisable(false)}>取消</ActionButton>
            <ActionButton type="button" disabled={!supported || Boolean(actionBusy)} onClick={() => { setConfirmDisable(false); onQuickAction?.("disable-stop"); }}>确认 DISABLE 并停止</ActionButton>
          </footer>
        </section>
      </div>}
    </main>
  );
  return controlView && renderControl ? renderControl(content, manager, observationReason, controlNotices) : content;
}
