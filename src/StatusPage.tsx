import { useEffect, useRef } from "react";
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
  buildStatusCards,
  buildStatusQuickActions,
  toneLabel,
  type BridgeHelloInfo,
  type StatusCardAction,
  type StatusCardModel,
  type StatusTone,
} from "./statusLogic";
import { isVlaControllerActive } from "./vlaLogic";

function ToneBadge({ tone }: { tone: StatusTone }) {
  return <span className={`status-card-tone ${tone}`}>{toneLabel(tone)}</span>;
}

function StatusCard({
  card,
  highlighted,
  onAction,
}: {
  card: StatusCardModel;
  highlighted: boolean;
  onAction?: (action: StatusCardAction, card: StatusCardModel) => void;
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
      className={`status-card tone-${card.tone}${highlighted ? " highlighted" : ""}`}
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
      {card.note && <p className="status-card-note">{card.note}</p>}
      {card.actions && card.actions.length > 0 && (
        <div className="status-card-actions" aria-label={`${card.title} 操作`}>
          {card.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`status-card-action ${action.kind}`}
              disabled={action.disabled}
              title={action.disabledReason || action.label}
              onClick={() => onAction?.(action, card)}
            >
              {action.label}
            </button>
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
  onCardAction?: (action: StatusCardAction, card: StatusCardModel) => void;
  onQuickAction?: (id: "teleop" | "trajectory" | "vla" | "stop") => void;
}) {
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
  const quickActions = buildStatusQuickActions({
    sshOk,
    rosReady: isRosReady(jointState),
    actionBusy,
    vlaActive: isVlaControllerActive(rosControl),
  });

  return (
    <main className="status-page">
      <header className="status-page-header">
        <div>
          <h1>Status</h1>
          <span>系统状态总览 · 可刷新 USB / 重启 Agent · 一键 Teleop/Trajectory/VLA</span>
        </div>
        <div className="status-page-meta" title="不刷写固件；Bridge 升级仍走既有 mismatch 提示">
          <span>NO FLASH</span>
          <strong>{profile.name || profile.host}</strong>
        </div>
      </header>
      <p className="status-page-banner" role="note">
        重要组件展示成功详情或失败原因；可重启项提供「重新拉起」，纯 USB 仅「刷新检测」。一键 Teleop / Trajectory 经 SSH 启动；VLA 经 switch_controllers 激活 vla_position_controller（保持 gravity）。切换前 HOLD，互斥停旧进程。不提供一键升级全部、自动刷写 STM32。
      </p>
      <section className="status-quick-actions" aria-label="一键启动">
        {quickActions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`status-quick-action ${action.id}`}
            disabled={action.disabled}
            title={action.disabledReason || action.label}
            onClick={() => onQuickAction?.(action.id)}
          >
            {action.label}
          </button>
        ))}
        {actionNotice && <output className="status-action-notice">{actionNotice}</output>}
      </section>
      <div className="status-card-grid" aria-label="状态卡片">
        {cards.map((card) => (
          <StatusCard key={card.id} card={card} highlighted={highlightCardId === card.id} onAction={onCardAction} />
        ))}
      </div>
    </main>
  );
}
