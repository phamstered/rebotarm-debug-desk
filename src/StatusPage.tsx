import { useEffect, useRef } from "react";
import type { AgentServiceStatus, ConnectionProfile, HardwareStatus, RosControlStatus } from "./types";
import type { TopicSample } from "./appLogic";
import {
  buildStatusCards,
  toneLabel,
  type BridgeHelloInfo,
  type StatusCardModel,
  type StatusTone,
} from "./statusLogic";

function ToneBadge({ tone }: { tone: StatusTone }) {
  return <span className={`status-card-tone ${tone}`}>{toneLabel(tone)}</span>;
}

function StatusCard({ card, highlighted }: { card: StatusCardModel; highlighted: boolean }) {
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
      <dl className="status-card-rows">
        {card.rows.map((row) => (
          <div key={row.label} className="status-card-row">
            <dt>{row.label}</dt>
            <dd className={row.tone ? `tone-${row.tone}` : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {card.note && <p className="status-card-note">{card.note}</p>}
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
  });

  return (
    <main className="status-page">
      <header className="status-page-header">
        <div>
          <h1>Status</h1>
          <span>只读系统状态总览 · 不执行升级或刷写</span>
        </div>
        <div className="status-page-meta" title="只读；Bridge 升级仍走既有 mismatch 提示">
          <span>READ-ONLY</span>
          <strong>{profile.name || profile.host}</strong>
        </div>
      </header>
      <p className="status-page-banner" role="note">
        本页仅展示连接与运行态。不提供一键升级全部、自动刷写 STM32，也不把 Bridge 部署与 ros2-stack 同步绑成同一按钮。
      </p>
      <div className="status-card-grid" aria-label="状态卡片">
        {cards.map((card) => (
          <StatusCard key={card.id} card={card} highlighted={highlightCardId === card.id} />
        ))}
      </div>
    </main>
  );
}
