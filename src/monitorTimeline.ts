/** Bag /clock and message-stamp timeline helpers for Monitor charts & playbar. */

export type RosTime = {
  sec: number;
  nanosec: number;
};

export type BagPlaybarSnapshot = {
  playing: boolean;
  /** Wall-clock ms when playback was last observed as started (local). */
  wallStartedAtMs: number | null;
  /** First bag-domain timestamp seen this session (ms). */
  bagOriginMs: number | null;
  /** Latest bag-domain clock (from /clock or message stamps), ms. */
  bagClockMs: number | null;
  /** Wall ms used for elapsed estimate when bag clock is unavailable. */
  wallNowMs: number;
};

export type BagPlaybarView = {
  rateLabel: string;
  elapsedMs: number;
  /** 0..1 when duration known; null when unknown (no bag metadata / seek). */
  progressRatio: number | null;
  elapsedLabel: string;
  statusLabel: string;
  seekAvailable: boolean;
};

const CLOCK_TOPIC_SUFFIX = "/clock";

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse ROS time object (`sec`/`nanosec` or `sec`/`nsec`). */
export function parseRosTime(value: unknown): RosTime | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const sec = asFiniteNumber(record.sec);
  const nanosec =
    asFiniteNumber(record.nanosec)
    ?? asFiniteNumber(record.nsec)
    ?? asFiniteNumber(record.nanoseconds);
  if (sec === undefined || nanosec === undefined) return undefined;
  if (nanosec < 0 || nanosec >= 1e9) return undefined;
  return { sec, nanosec };
}

export function rosTimeToMillis(stamp: RosTime): number {
  return stamp.sec * 1000 + stamp.nanosec / 1e6;
}

/** Prefer header.stamp, then top-level stamp, then Clock `{ clock: … }`. */
export function extractMessageTimeMs(data: unknown): number | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const header = record.header;
  if (header && typeof header === "object") {
    const headerStamp = parseRosTime((header as Record<string, unknown>).stamp);
    if (headerStamp) return rosTimeToMillis(headerStamp);
  }
  const topStamp = parseRosTime(record.stamp);
  if (topStamp) return rosTimeToMillis(topStamp);
  const clock = parseRosTime(record.clock);
  if (clock) return rosTimeToMillis(clock);
  return undefined;
}

export function isClockTopic(topic: string): boolean {
  return topic === CLOCK_TOPIC_SUFFIX || topic.endsWith(CLOCK_TOPIC_SUFFIX);
}

/** Update bag clock from a topic message; returns next clock ms (or previous). */
export function nextBagClockMs(
  topic: string,
  data: unknown,
  previousBagClockMs: number | null,
): number | null {
  if (isClockTopic(topic)) {
    const fromClock = extractMessageTimeMs(data);
    if (fromClock !== undefined) return fromClock;
  }
  const fromMessage = extractMessageTimeMs(data);
  if (fromMessage !== undefined) {
    if (previousBagClockMs == null || fromMessage >= previousBagClockMs) return fromMessage;
  }
  return previousBagClockMs;
}

/**
 * Resolve sample timestamp for Monitor series.
 * Live: wall clock. Bag playing: message/`/clock` when available, else wall.
 */
export function resolveMonitorSampleTimeMs(options: {
  bagPlaying: boolean;
  topic: string;
  data: unknown;
  wallNowMs: number;
  bagClockMs: number | null;
}): { sampleMs: number; bagClockMs: number | null; usedBagTime: boolean } {
  const { bagPlaying, topic, data, wallNowMs } = options;
  if (!bagPlaying) {
    return { sampleMs: wallNowMs, bagClockMs: null, usedBagTime: false };
  }
  const bagClockMs = nextBagClockMs(topic, data, options.bagClockMs);
  const messageMs = extractMessageTimeMs(data);
  if (messageMs !== undefined) {
    return { sampleMs: messageMs, bagClockMs, usedBagTime: true };
  }
  if (bagClockMs != null) {
    return { sampleMs: bagClockMs, bagClockMs, usedBagTime: true };
  }
  return { sampleMs: wallNowMs, bagClockMs, usedBagTime: false };
}

/** Chart/crosshair "now" while bag is playing: prefer bag clock, else wall. */
export function resolveMonitorViewNowMs(options: {
  bagPlaying: boolean;
  bagClockMs: number | null;
  wallNowMs: number;
  frozenNowMs: number | null;
}): number | null {
  if (options.frozenNowMs != null) return options.frozenNowMs;
  if (options.bagPlaying && options.bagClockMs != null) return options.bagClockMs;
  // null → DataGraph uses performance.now() for live wall sliding window
  return null;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Playbar view model. Seek/scrub are unavailable without Bridge bag metadata.
 * Progress uses bag-clock delta when possible, else wall elapsed since start.
 */
export function buildBagPlaybarView(snapshot: BagPlaybarSnapshot): BagPlaybarView {
  const seekAvailable = false;
  const rateLabel = "1x";
  if (!snapshot.playing) {
    return {
      rateLabel,
      elapsedMs: 0,
      progressRatio: null,
      elapsedLabel: "0:00",
      statusLabel: "已停止",
      seekAvailable,
    };
  }

  let elapsedMs = 0;
  if (
    snapshot.bagClockMs != null
    && snapshot.bagOriginMs != null
    && snapshot.bagClockMs >= snapshot.bagOriginMs
  ) {
    elapsedMs = snapshot.bagClockMs - snapshot.bagOriginMs;
  } else if (snapshot.wallStartedAtMs != null) {
    elapsedMs = Math.max(0, snapshot.wallNowMs - snapshot.wallStartedAtMs);
  }

  const sourceHint =
    snapshot.bagClockMs != null
      ? "时间轴：bag /clock 或消息 stamp"
      : "时间轴：墙钟估算（尚未收到 /clock 或 stamp）";

  return {
    rateLabel,
    elapsedMs,
    progressRatio: null,
    elapsedLabel: formatDurationMs(elapsedMs),
    statusLabel: `播放中 · ${rateLabel} · ${sourceHint}`,
    seekAvailable,
  };
}

export const BAG_SEEK_CAVEAT_ZH =
  "远端 Bridge/SSH 仅支持 rosbag play 启停，不支持 pause 保位或 seek/scrub；暂停即停止回放，再次播放从 bag 开头。";
