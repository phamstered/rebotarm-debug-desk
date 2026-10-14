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
    expect(container.querySelectorAll(".graph-node.node rect")).toHaveLength(1);
    expect(container.querySelectorAll(".graph-node.topic ellipse")).toHaveLength(1);
    expect(container.querySelector(".graph-edge")).toHaveClass("related");
  });

  it("focuses a topic selected in the sidebar and forwards node selection", async () => {
    const onSelectNode = vi.fn();
    const bridge = bridgeDouble();
    const onSelectTopic = vi.fn();
    const { container, rerender } = render(<TopicGraph bridge={bridge} onSelectTopic={onSelectTopic} onSelectNode={onSelectNode} selectedTopic="/joint_states" />);
    expect(await screen.findByRole("button", { name: "Topic /joint_states" })).toHaveClass("selected");
    expect(container.querySelector<HTMLElement>(".graph-canvas-scroll")?.scrollLeft).toBeGreaterThan(0);
    rerender(<TopicGraph bridge={bridge} onSelectTopic={onSelectTopic} onSelectNode={onSelectNode} selectedNode="/driver" />);
    expect(screen.getByRole("button", { name: "Node /driver" })).toHaveClass("selected");
    fireEvent.click(screen.getByRole("button", { name: "Node /driver" }));
    expect(onSelectNode).toHaveBeenCalledWith("/driver");
  });

  it("hides Bridge nodes by default and restores them with the saved toggle", async () => {
    const bridge = { getGraph: vi.fn().mockResolvedValue({
      nodes: [...graph.nodes, { id: "node:/easy_debug_bridge", label: "/easy_debug_bridge", kind: "node", types: [] }],
      edges: [...graph.edges, { source: "node:/easy_debug_bridge", target: "topic:/joint_states", relation: "subscribe" }],
    }) } as unknown as BridgeClient;
    const user = userEvent.setup();
    render(<TopicGraph bridge={bridge} onSelectTopic={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Topic /joint_states" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Node /easy_debug_bridge" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "显示 Bridge" }));
    expect(screen.getByRole("button", { name: "Node /easy_debug_bridge" })).toBeVisible();
    expect(localStorage.getItem("robot-console-graph-show-bridge")).toBe("true");
  });

  it("highlights the selected controller relation", async () => {
    const bridge = { getGraph: vi.fn().mockResolvedValue({
      nodes: [...graph.nodes, { id: "node:/arm_controller", label: "/arm_controller", kind: "node", types: [] }, { id: "topic:/arm_controller/state", label: "/arm_controller/state", kind: "topic", types: [] }],
      edges: [...graph.edges, { source: "node:/arm_controller", target: "topic:/arm_controller/state", relation: "publish" }],
    }) } as unknown as BridgeClient;
    const { container } = render(<TopicGraph bridge={bridge} onSelectTopic={vi.fn()} focusController="arm_controller" />);
    expect(await screen.findByRole("button", { name: "Node /arm_controller" })).toHaveClass("selected");
    expect(screen.getByRole("button", { name: "Topic /joint_states" })).toHaveClass("dimmed");
    expect(container.querySelectorAll(".graph-edge.related")).toHaveLength(1);
  });
});
