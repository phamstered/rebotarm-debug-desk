import { describe, expect, it } from "vitest";
import {
  BAG_SEEK_CAVEAT_ZH,
  buildBagPlaybarView,
  extractMessageTimeMs,
  formatDurationMs,
  isClockTopic,
  nextBagClockMs,
  parseRosTime,
  resolveMonitorSampleTimeMs,
  resolveMonitorViewNowMs,
  rosTimeToMillis,
} from "./monitorTimeline";

describe("monitorTimeline ROS time", () => {
  it("parses sec/nanosec and sec/nsec stamps", () => {
    expect(parseRosTime({ sec: 10, nanosec: 500_000_000 })).toEqual({ sec: 10, nanosec: 500_000_000 });
    expect(parseRosTime({ sec: 1, nsec: 250_000_000 })).toEqual({ sec: 1, nanosec: 250_000_000 });
    expect(parseRosTime({ sec: 1, nanosec: 1e9 })).toBeUndefined();
    expect(rosTimeToMillis({ sec: 2, nanosec: 250_000_000 })).toBe(2250);
  });

  it("extracts header.stamp, top-level stamp, and Clock messages", () => {
    expect(extractMessageTimeMs({
      header: { stamp: { sec: 100, nanosec: 0 } },
      data: 1,
    })).toBe(100_000);
    expect(extractMessageTimeMs({ stamp: { sec: 5, nsec: 0 } })).toBe(5_000);
    expect(extractMessageTimeMs({ clock: { sec: 7, nanosec: 0 } })).toBe(7_000);
    expect(extractMessageTimeMs({ effort: [1] })).toBeUndefined();
  });

  it("detects /clock topics and advances bag clock monotonically", () => {
    expect(isClockTopic("/clock")).toBe(true);
    expect(isClockTopic("/foo/clock")).toBe(true);
    expect(isClockTopic("/joint_states")).toBe(false);
    expect(nextBagClockMs("/clock", { clock: { sec: 3, nanosec: 0 } }, null)).toBe(3_000);
    expect(nextBagClockMs("/js", { header: { stamp: { sec: 4, nanosec: 0 } } }, 3_000)).toBe(4_000);
    expect(nextBagClockMs("/js", { header: { stamp: { sec: 2, nanosec: 0 } } }, 4_000)).toBe(4_000);
  });
});

describe("monitorTimeline sample/view resolution", () => {
  it("uses wall time when not playing a bag", () => {
    const result = resolveMonitorSampleTimeMs({
      bagPlaying: false,
      topic: "/js",
      data: { header: { stamp: { sec: 9, nanosec: 0 } } },
      wallNowMs: 42,
      bagClockMs: null,
    });
    expect(result).toEqual({ sampleMs: 42, bagClockMs: null, usedBagTime: false });
  });

  it("prefers message stamp then bag clock while playing", () => {
    const stamped = resolveMonitorSampleTimeMs({
      bagPlaying: true,
      topic: "/js",
      data: { header: { stamp: { sec: 11, nanosec: 0 } } },
      wallNowMs: 999,
      bagClockMs: 10_000,
    });
    expect(stamped.sampleMs).toBe(11_000);
    expect(stamped.usedBagTime).toBe(true);

    const fallback = resolveMonitorSampleTimeMs({
      bagPlaying: true,
      topic: "/js",
      data: { effort: [1] },
      wallNowMs: 999,
      bagClockMs: 12_500,
    });
    expect(fallback.sampleMs).toBe(12_500);
    expect(fallback.usedBagTime).toBe(true);
  });

  it("resolves viewNow for bag clock and frozen pause", () => {
    expect(resolveMonitorViewNowMs({
      bagPlaying: true,
      bagClockMs: 8_000,
      wallNowMs: 1,
      frozenNowMs: null,
    })).toBe(8_000);
    expect(resolveMonitorViewNowMs({
      bagPlaying: true,
      bagClockMs: 8_000,
      wallNowMs: 1,
      frozenNowMs: 3,
    })).toBe(3);
    expect(resolveMonitorViewNowMs({
      bagPlaying: false,
      bagClockMs: null,
      wallNowMs: 1,
      frozenNowMs: null,
    })).toBeNull();
  });
});

describe("monitorTimeline playbar", () => {
  it("formats durations and builds elapsed from bag clock delta", () => {
    expect(formatDurationMs(0)).toBe("0:00");
    expect(formatDurationMs(65_000)).toBe("1:05");
    expect(formatDurationMs(3_661_000)).toBe("1:01:01");

    const playing = buildBagPlaybarView({
      playing: true,
      wallStartedAtMs: 1_000,
      bagOriginMs: 10_000,
      bagClockMs: 25_000,
      wallNowMs: 9_000,
    });
    expect(playing.elapsedMs).toBe(15_000);
    expect(playing.elapsedLabel).toBe("0:15");
    expect(playing.rateLabel).toBe("1x");
    expect(playing.progressRatio).toBeNull();
    expect(playing.seekAvailable).toBe(false);
    expect(playing.statusLabel).toContain("播放中");
    expect(BAG_SEEK_CAVEAT_ZH).toContain("seek");

    const idle = buildBagPlaybarView({
      playing: false,
      wallStartedAtMs: null,
      bagOriginMs: null,
      bagClockMs: null,
      wallNowMs: 0,
    });
    expect(idle.statusLabel).toBe("已停止");
  });

  it("falls back to wall elapsed when bag clock is missing", () => {
    const view = buildBagPlaybarView({
      playing: true,
      wallStartedAtMs: 100,
      bagOriginMs: null,
      bagClockMs: null,
      wallNowMs: 5_100,
    });
    expect(view.elapsedMs).toBe(5_000);
    expect(view.statusLabel).toContain("墙钟估算");
  });
});
