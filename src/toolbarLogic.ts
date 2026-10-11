import type { AgentServiceStatus, ConnectionProfile, HardwareStatus, RosControlStatus, TopicInfo } from "./types";
import type { TopicSample } from "./appLogic";

export type ToolbarSettings = {
  refreshIntervalSeconds: number;
  includeMessagePreviews: boolean;
};

export const defaultToolbarSettings: ToolbarSettings = {
  refreshIntervalSeconds: 30,
  includeMessagePreviews: true,
};

export function normalizeToolbarSettings(saved: Partial<ToolbarSettings>): ToolbarSettings {
  const interval = typeof saved.refreshIntervalSeconds === "number" && Number.isFinite(saved.refreshIntervalSeconds)
    ? Math.round(saved.refreshIntervalSeconds)
    : defaultToolbarSettings.refreshIntervalSeconds;
  return {
    refreshIntervalSeconds: Math.min(300, Math.max(5, interval)),
    includeMessagePreviews: typeof saved.includeMessagePreviews === "boolean"
      ? saved.includeMessagePreviews
      : defaultToolbarSettings.includeMessagePreviews,
  };
}

export function loadToolbarSettings(storage: Pick<Storage, "getItem"> = localStorage): ToolbarSettings {
  try {
    const saved = storage.getItem("robot-console-toolbar-settings");
    return saved ? normalizeToolbarSettings(JSON.parse(saved) as Partial<ToolbarSettings>) : defaultToolbarSettings;
  } catch {
    return defaultToolbarSettings;
  }
}

function messagePreview(data: unknown): unknown {
  const serialized = JSON.stringify(data);
  if (!serialized) return data;
  if (serialized.length <= 4096) return data;
  return { omitted: true, serializedBytes: new TextEncoder().encode(serialized).byteLength };
}

export function buildDiagnosticsSnapshot(input: {
  profile: ConnectionProfile;
  topics: TopicInfo[];
  rosControl: RosControlStatus | null;
  agentStatus: AgentServiceStatus | null;
  agentError: string;
  hardwareStatus: HardwareStatus | null;
  selectedTopic: string;
  messages: Record<string, TopicSample>;
  liveUpdates: boolean;
  includeMessagePreviews: boolean;
  capturedAt?: string;
}): string {
  const messageStats = Object.fromEntries(Object.entries(input.messages).map(([topic, sample]) => [topic, {
    count: sample.count,
    hz: sample.hz,
    firstAt: sample.firstAt,
    lastAt: sample.lastAt,
    ...(input.includeMessagePreviews ? { preview: messagePreview(sample.data) } : {}),
  }]));
  return JSON.stringify({
    schemaVersion: 1,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    connection: {
      name: input.profile.name,
      host: input.profile.host,
      sshPort: input.profile.sshPort,
      rosDomainId: input.profile.rosDomainId,
      urdfTopic: input.profile.urdfTopic,
      jointStateTopic: input.profile.jointStateTopic,
      commandTopic: input.profile.commandTopic,
      statusTopic: input.profile.statusTopic,
      tcpLink: input.profile.tcpLink,
    },
    liveUpdates: input.liveUpdates,
    topics: input.topics,
    rosControl: input.rosControl,
    microRosAgent: input.agentStatus,
    microRosAgentError: input.agentError,
    hardwareStatus: input.hardwareStatus,
    selectedTopic: input.selectedTopic,
    messageStats,
  }, null, 2);
}
