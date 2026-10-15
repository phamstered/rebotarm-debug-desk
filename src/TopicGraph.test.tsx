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

  it("keeps a dragged node moved and still selects on click", async () => {
    const bridge = bridgeDouble();
    const onSelectTopic = vi.fn();
    const { container } = render(<TopicGraph bridge={bridge} onSelectTopic={onSelectTopic} />);
    const topic = await screen.findByRole("button", { name: "Topic /joint_states" });
    const before = topic.getAttribute("transform");

    fireEvent.pointerDown(topic, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(topic, { button: 0, clientX: 210, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(topic, { button: 0, clientX: 210, clientY: 180, pointerId: 1 });
    expect(topic.getAttribute("transform")).not.toBe(before);
    expect(onSelectTopic).not.toHaveBeenCalled();

    fireEvent.pointerDown(topic, { button: 0, clientX: 210, clientY: 180, pointerId: 2 });
    fireEvent.pointerUp(topic, { button: 0, clientX: 211, clientY: 180, pointerId: 2 });
    fireEvent.click(topic);
    expect(onSelectTopic).toHaveBeenCalledWith({ name: "/joint_states", types: ["sensor_msgs/msg/JointState"] });
    expect(container.querySelectorAll(".graph-flow-particle")).not.toHaveLength(0);
  });

  it("keeps the selected node and the user's canvas pan without snapping back", async () => {
    const { container } = render(<TopicGraph bridge={bridgeDouble()} onSelectTopic={vi.fn()} />);
    const topic = await screen.findByRole("button", { name: "Topic /joint_states" });
    fireEvent.click(topic);
    expect(topic).toHaveClass("selected");
    const svg = container.querySelector("svg.graph-canvas")!;
    const cameraGroup = svg.querySelector(":scope > g")!;
    const before = cameraGroup.getAttribute("transform");

    fireEvent.pointerDown(svg, { button: 0, clientX: 200, clientY: 180, pointerId: 3 });
    fireEvent.pointerMove(svg, { button: 0, clientX: 290, clientY: 220, pointerId: 3 });
    const panned = cameraGroup.getAttribute("transform");
    expect(panned).not.toBe(before);
    fireEvent.pointerUp(svg, { button: 0, clientX: 290, clientY: 220, pointerId: 3 });
    expect(cameraGroup.getAttribute("transform")).toBe(panned);
    expect(topic).toHaveClass("selected");
  });

  it("renders the original Topic path in the node label", async () => {
    const { container } = render(<TopicGraph bridge={bridgeDouble()} onSelectTopic={vi.fn()} />);
    const topic = await screen.findByRole("button", { name: "Topic /joint_states" });
    expect(Array.from(topic.querySelectorAll("tspan"), (line) => line.textContent).join("")).toBe("/joint_states");
    expect(container.querySelector(".graph-node.topic title")?.textContent).toBe("Topic: /joint_states");
  });

  it("exposes zoom controls and fits the camera", async () => {
    const bridge = bridgeDouble();
    const user = userEvent.setup();
    render(<TopicGraph bridge={bridge} onSelectTopic={vi.fn()} />);
    expect(await screen.findByText(/\d+%/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "放大" }));
    expect(Number(screen.getByText(/\d+%/).textContent?.replace("%", ""))).toBeGreaterThan(100);
    await user.click(screen.getByRole("button", { name: "Fit" }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByText("100%")).toBeVisible();
  });
});
