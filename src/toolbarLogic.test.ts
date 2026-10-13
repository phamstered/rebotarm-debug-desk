import { describe, expect, it } from "vitest";
import { buildDiagnosticsSnapshot, defaultToolbarSettings, loadToolbarSettings, normalizeToolbarSettings } from "./toolbarLogic";
import { defaultProfile } from "./types";

describe("global toolbar logic", () => {
  it("loads, bounds and repairs toolbar settings", () => {
    expect(loadToolbarSettings({ getItem: () => null })).toEqual(defaultToolbarSettings);
    expect(normalizeToolbarSettings({ refreshIntervalSeconds: 1, includeMessagePreviews: false })).toEqual({
      refreshIntervalSeconds: 5,
      includeMessagePreviews: false,
    });
    expect(normalizeToolbarSettings({ refreshIntervalSeconds: 999 })).toEqual({
      refreshIntervalSeconds: 300,
      includeMessagePreviews: true,
    });
    expect(loadToolbarSettings({ getItem: () => "bad" })).toEqual(defaultToolbarSettings);
  });

  it("builds a redacted diagnostics snapshot and bounds large previews", () => {
    const snapshot = JSON.parse(buildDiagnosticsSnapshot({
      profile: { ...defaultProfile, identityFile: "/secret/id_ed25519" },
      topics: [{ name: "/camera", types: ["sensor_msgs/msg/Image"] }],
      rosControl: null,
      agentStatus: null,
      agentError: "",
      hardwareStatus: { fault_code: 0 },
      selectedTopic: "/camera",
      messages: {
        "/camera": { data: { data: "x".repeat(5000) }, count: 2, firstAt: 10, lastAt: 20, hz: 100 },
      },
      liveUpdates: false,
      includeMessagePreviews: true,
      capturedAt: "2026-10-11T12:00:00.000Z",
    }));
    expect(snapshot.connection.identityFile).toBeUndefined();
    expect(snapshot.connection.host).toBe("jetson");
    expect(snapshot.messageStats["/camera"].preview).toEqual(expect.objectContaining({ omitted: true }));
    expect(snapshot.capturedAt).toBe("2026-10-11T12:00:00.000Z");
  });
});
