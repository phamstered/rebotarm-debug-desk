import { describe, expect, it } from "vitest";
import { isTeachPath, relayFeedback, teachLiveUrl, teachToken } from "./teachPendantLogic";
import { ARM_JOINT_NAMES } from "./positionLogic";

const fresh = (now: number) => ({
  topic: "/stm32/joint_states",
  state: { name: [...ARM_JOINT_NAMES], position: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] },
  receivedAt: now,
});

describe("desk relay for the phone pose page", () => {
  it("keeps the phone on the desk origin and refuses to save without the desktop bridge", () => {
    expect(isTeachPath("/teach")).toBe(true);
    expect(isTeachPath("/")).toBe(false);
    expect(teachToken("?token=abc")).toBe("abc");
    const live = teachLiveUrl("http://10.0.0.8:17420/teach?token=abc");
    expect(live).toBe("ws://10.0.0.8:17420/api/teach/live?token=abc");
    expect(live).not.toContain("jetson");
    expect(live).not.toContain("8765");
    const offline = relayFeedback({
      bridgeConnected: false,
      profileKey: "jetson|op|22",
      samples: [fresh(10)],
      now: 10,
      preferredTopic: "/stm32/joint_states",
    });
    expect(offline.bridgeConnected).toBe(false);
    expect(offline.positions).toBeNull();
    expect(offline.error).toContain("尚未连接");
  });

  it("relays the same fresh joint snapshot the desktop save uses", () => {
    const ready = relayFeedback({
      bridgeConnected: true,
      profileKey: "jetson|op|22",
      samples: [fresh(10)],
      now: 10,
      preferredTopic: "/stm32/joint_states",
      gripperPosition: 0.02,
    });
    expect(ready.error).toBe("");
    expect(ready.positions).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    expect(ready.gripperPosition).toBe(0.02);
    const stale = relayFeedback({ ...{
      bridgeConnected: true,
      profileKey: "jetson|op|22",
      samples: [fresh(10)],
      preferredTopic: "/stm32/joint_states",
    }, now: 5000 });
    expect(stale.positions).toBeNull();
    expect(stale.error).toContain("过期");
  });
});
