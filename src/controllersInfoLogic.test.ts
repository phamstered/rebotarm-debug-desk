import { describe, expect, it } from "vitest";
import {
  controllerStatusFresh,
  controllerStatusLabel,
  parseControllersInfo,
} from "./controllersInfoLogic";
export const controllerWire = (changes: Record<string, unknown> = {}) => ({
  op: "controllers_info",
  supported: true,
  manager: "/controller_manager",
  available: true,
  fresh: true,
  has_snapshot: true,
  snapshot_sequence: 1,
  snapshot_age_ms: 0,
  snapshot_time_ms: 1793600000000,
  query_state: "ready",
  query_pending: false,
  retry_after_ms: 0,
  request_wait_ms: 0,
  controllers: [
    { name: "arm", type_name: "test/Controller", state: "inactive" },
  ],
  message: "",
  ...changes,
});
describe("controllers_info decoder", () => {
  it("normalizes cached metadata and rows without interpreting failure rows as current", () => {
    expect(parseControllersInfo(controllerWire())).toMatchObject({
      fresh: true,
      hasSnapshot: true,
      snapshotSequence: 1,
      snapshotAgeMs: 0,
      queryState: "ready",
      requestWaitMs: 0,
      controllers: [
        { name: "arm", typeName: "test/Controller", state: "inactive" },
      ],
    });
    const stale = parseControllersInfo(
      controllerWire({
        fresh: false,
        available: false,
        query_state: "timeout",
        message: "ListControllers超时",
      }),
    );
    expect(stale.controllers).toHaveLength(1);
    expect(controllerStatusFresh(stale)).toBe(false);
    expect(controllerStatusLabel(stale)).toBe("查询超时");
  });

  it("accepts a fresh cached snapshot while a background query is pending and retains failed pending reasons", () => {
    expect(
      controllerStatusFresh(
        parseControllersInfo(
          controllerWire({ query_state: "pending", query_pending: true }),
        ),
      ),
    ).toBe(true);
    expect(
      parseControllersInfo(
        controllerWire({
          fresh: false,
          available: false,
          query_state: "timeout",
          query_pending: true,
        }),
      ),
    ).toMatchObject({
      queryState: "timeout",
      queryPending: true,
      fresh: false,
    });
  });
  it("accepts waiting and unsupported responses without a fabricated snapshot", () => {
    const waiting = controllerWire({
      fresh: false,
      available: false,
      has_snapshot: false,
      snapshot_sequence: 0,
      snapshot_age_ms: undefined,
      snapshot_time_ms: undefined,
      controllers: [],
      query_state: "waiting",
    });
    expect(parseControllersInfo(waiting)).toMatchObject({
      hasSnapshot: false,
      snapshotSequence: 0,
      controllers: [],
    });
    expect(
      controllerStatusLabel(
        parseControllersInfo({
          ...waiting,
          supported: false,
          query_state: "unsupported",
        }),
      ),
    ).toBe("需升级 Bridge");
  });
  it.each([
    { fresh: undefined },
    ...["timeout", "unavailable", "error", "stale", "waiting"].map(
      (query_state) => ({ query_state }),
    ),
    { query_state: "pending", query_pending: false },
    { query_state: "ready", query_pending: true },
    { available: false },
    { snapshot_age_ms: 3100 },
    { snapshot_age_ms: -1 },
    { snapshot_time_ms: Infinity },
    { snapshot_sequence: 1.2 },
    { snapshot_sequence: -1 },
    { snapshot_sequence: Number.MAX_SAFE_INTEGER + 1 },
    { query_state: "mystery" },
    { query_pending: 1 },
    { retry_after_ms: NaN },
    { request_wait_ms: -1 },
    { request_wait_ms: 5001 },
    { request_wait_ms: NaN },
    { request_wait_ms: undefined },
    { supported: false },
    { has_snapshot: false },
    { manager: "/other_manager" },
    { controllers: null },
    {
      controllers: [
        { name: "arm", type_name: "test", state: "active" },
        { name: "/arm", type_name: "test", state: "active" },
      ],
    },
    { controllers: [{ name: " ", type_name: "test", state: "active" }] },
    { controllers: [{ name: "arm", typeName: "test", state: "active" }] },
    { controllers: [{ name: "arm", type_name: "test", state: 42 }] },
  ])("rejects malformed or unsafe response %j", (patch) =>
    expect(() => parseControllersInfo(controllerWire(patch))).toThrow(
      "响应无效",
    ),
  );
  it("requires explicit fresh metadata at every controller safety consumer", () => {
    expect(
      controllerStatusFresh({
        manager: "/controller_manager",
        available: true,
        message: "",
        controllers: [],
      }),
    ).toBe(false);
    expect(
      controllerStatusLabel(
        parseControllersInfo(
          controllerWire({
            fresh: false,
            available: false,
            query_state: "stale",
          }),
        ),
      ),
    ).toBe("已过期");
  });
});
