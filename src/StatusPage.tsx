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
import { isVlaControllerActive } from "./vlaLogic";

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
  onCardAction,
  onQuickAction,
  onClearHighlight,
}: {
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
  onClearHighlight?: () => void;
  onCardAction?: (action: StatusCardAction, card: StatusCardModel) => void;
  onQuickAction?: (id: "teleop" | "trajectory" | "vla" | "stop" | "disable-stop") => void;
}) {
  const [selectedTab, setSelectedTab] = useState<StatusZoneId>(() => statusZoneForCard(highlightCardId) ?? "connection");
  useEffect(() => {
    const zone = statusZoneForCard(highlightCardId);
    if (zone) setSelectedTab(zone);
  }, [highlightCardId]);
  const selectTab = (id: StatusZoneId) => { setSelectedTab(id); onClearHighlight?.(); };
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [supported, setSupported] = useState(false);
  const cards = buildStatusCards({
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
  const activeMode = useMemo(
    () => resolveActiveControlMode({ armMode, rosControl }),
    [armMode, rosControl],
  );
  const quickActions = buildStatusQuickActions({
    sshOk,
    rosReady: isRosReady(jointState),
    actionBusy,
    vlaActive: isVlaControllerActive(rosControl),
    hardwareStatus,
  });

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
        NO FLASH：不刷写 STM32、无一键升级全部。模式条互斥启停 Teleop / Trajectory / VLA；停止与解除输出仍走既有安全确认。
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
            ? zone.cards.filter((card) => card.id === activeMode)
            : zone.cards;
          const body = (
            <>
              {isControl && (
                <section className="status-mode-strip" aria-label="控制模式启停">
                  <div className="status-mode-segment" role="group" aria-label="互斥模式">
                    {quickActions.filter((action) => action.id === "teleop" || action.id === "trajectory" || action.id === "vla").map((action) => (
                      <div key={action.id} className="status-quick-action-wrap">
                        <button
                          type="button"
                          className={`status-quick-action ${action.id}${activeMode === action.id ? " active" : ""}`}
                          disabled={action.disabled}
                          aria-pressed={activeMode === action.id}
                          title={action.disabledReason || action.label}
                          onClick={() => onQuickAction?.(action.id)}
                        >
                          {action.label}
                        </button>
                        {action.disabled && action.disabledReason && (
                          <p className="status-disabled-hint" data-testid={`status-quick-disabled-${action.id}`}>
                            {action.disabledReason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="status-mode-stops" role="group" aria-label="停止">
                    {quickActions.filter((action) => action.id === "stop" || action.id === "disable-stop").map((action) => (
                      <div key={action.id} className="status-quick-action-wrap">
                        <button
                          type="button"
                          className={`status-quick-action ${action.id}`}
                          disabled={action.disabled}
                          title={action.disabledReason || action.label}
                          onClick={() => {
                            if (action.id === "disable-stop") { setSupported(false); setConfirmDisable(true); }
                            else onQuickAction?.(action.id);
                          }}
                        >
                          {action.label}
                        </button>
                        {action.disabled && action.disabledReason && (
                          <p className="status-disabled-hint" data-testid={`status-quick-disabled-${action.id}`}>
                            {action.disabledReason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  {actionNotice && <output className="status-action-notice">{actionNotice}</output>}
                </section>
              )}
              {isControl && !activeMode && (
                <p className="status-mode-idle" data-testid="status-mode-idle">当前无运行中模式 · 使用上方模式条启动</p>
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
              {isControl && <ControlLogViewer profile={profile} connected={sshOk} active={selectedTab === "control"}
                preferredSource={activeMode === "vla" ? "controller" : activeMode === "trajectory" ? "trajectory" : "teleop"} />}
            </section>
          );
        })}
      </div>
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
