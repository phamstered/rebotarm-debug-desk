import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "./bridge";
import { TopicGraph } from "./TopicGraph";
import type { RosGraph } from "./types";

const graph: RosGraph = {
  nodes: [
    { id: "node:/driver", label: "/driver", kind: "node", types: [] },
    { id: "topic:/joint_states", label: "/joint_states", kind: "topic", types: ["sensor_msgs/msg/JointState"] },
  ],
  edges: [{ source: "node:/driver", target: "topic:/joint_states", relation: "publish" }],
};

function bridgeDouble() {
  return {
    getGraph: vi.fn().mockResolvedValue(graph),
  } as unknown as BridgeClient;
}

describe("TopicGraph", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("refreshes the ROS graph immediately, manually and every 30 seconds", async () => {
    vi.useFakeTimers();
    const bridge = bridgeDouble();
    render(<TopicGraph bridge={bridge} onSelectTopic={vi.fn()} />);
    await act(async () => Promise.resolve());
    expect(bridge.getGraph).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "刷新 Graph" }));
    await act(async () => Promise.resolve());
    expect(bridge.getGraph).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(bridge.getGraph).toHaveBeenCalledTimes(3);
  });

  it("focuses related connections and forwards topic selection to Topic Inspector", async () => {
    const bridge = bridgeDouble();
    const onSelectTopic = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<TopicGraph bridge={bridge} onSelectTopic={onSelectTopic} />);

    await user.click(await screen.findByRole("button", { name: "Topic /joint_states" }));
    expect(onSelectTopic).toHaveBeenCalledWith({ name: "/joint_states", types: ["sensor_msgs/msg/JointState"] });
    expect(container.querySelector(".graph-node.topic")).toHaveClass("selected");
    expect(container.querySelector(".graph-edge")).toHaveClass("related");
  });
});
