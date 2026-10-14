import { describe, expect, it } from "vitest";
import { controllerGraphFocus, filterBridgeGraph, graphEdgeKey, layoutRosGraph, loadBridgeVisibility } from "./topicGraphLogic";
import type { RosGraph } from "./types";

const graph: RosGraph = {
  nodes: [
    { id: "node:/driver", label: "/driver", kind: "node", types: [] },
    { id: "topic:/joint_states", label: "/joint_states", kind: "topic", types: ["sensor_msgs/msg/JointState"] },
    { id: "node:/viewer", label: "/viewer", kind: "node", types: [] },
  ],
  edges: [
    { source: "node:/driver", target: "topic:/joint_states", relation: "publish" },
    { source: "topic:/joint_states", target: "node:/viewer", relation: "subscribe" },
  ],
};

describe("force-directed topic graph layout", () => {
  it("keeps directed ROS relations and uses circular nodes sized by degree", () => {
    const layout = layoutRosGraph(graph);
    expect(layout.edges).toEqual(graph.edges);
    expect(layout.nodes.find((node) => node.id === "topic:/joint_states")!.radius).toBeGreaterThan(16);
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("keeps nodes inside a responsive canvas without overlapping circles", () => {
    const dense: RosGraph = {
      nodes: Array.from({ length: 32 }, (_, index) => ({ id: `topic:/arm/topic_${index}`, label: `/arm/topic_${index}`, kind: "topic" as const, types: [] })),
      edges: Array.from({ length: 31 }, (_, index) => ({ source: "topic:/arm/topic_0", target: `topic:/arm/topic_${index + 1}`, relation: "publish" as const })),
    };
    const layout = layoutRosGraph(dense, { width: 500, height: 320 });
    expect(layout.width).toBeGreaterThanOrEqual(680);
    expect(layout.height).toBeGreaterThanOrEqual(560);
    layout.nodes.forEach((node, index) => {
      expect(node.x).toBeGreaterThanOrEqual(node.radius);
      expect(node.x).toBeLessThanOrEqual(layout.width - node.radius);
      expect(node.y).toBeGreaterThanOrEqual(node.radius);
      expect(node.y).toBeLessThanOrEqual(layout.height - node.radius);
      layout.nodes.slice(index + 1).forEach((other) => {
        expect(Math.hypot(node.x - other.x, node.y - other.y)).toBeGreaterThanOrEqual(node.radius + other.radius - 0.1);
      });
    });
    expect(layout.nodes.find((node) => node.id === "topic:/arm/topic_0")!.radius)
      .toBeGreaterThan(layout.nodes.find((node) => node.id === "topic:/arm/topic_1")!.radius);
  });

  it("is deterministic across refreshes and adapts to the viewport", () => {
    const wide = layoutRosGraph(graph, { width: 1500, height: 700 });
    const narrow = layoutRosGraph(graph, { width: 800, height: 560 });
    expect(wide.width).toBe(1500);
    expect(layoutRosGraph(graph, { width: 800, height: 560 })).toEqual(narrow);
    expect(wide.nodes.some((node, index) => node.x !== narrow.nodes[index]?.x)).toBe(true);
  });

  it("hides Bridge nodes and private topics while retaining shared robot topics", () => {
    const withBridge: RosGraph = {
      nodes: [
        ...graph.nodes,
        { id: "node:/easy_debug_bridge", label: "/easy_debug_bridge", kind: "node", types: [] },
        { id: "topic:/easy_debug_bridge/status", label: "/easy_debug_bridge/status", kind: "topic", types: [] },
      ],
      edges: [...graph.edges, { source: "node:/easy_debug_bridge", target: "topic:/joint_states", relation: "subscribe" }, { source: "node:/easy_debug_bridge", target: "topic:/easy_debug_bridge/status", relation: "publish" }],
    };
    const filtered = filterBridgeGraph(withBridge, false);
    expect(filtered.nodes.map((node) => node.label)).toEqual(["/driver", "/joint_states", "/viewer"]);
    expect(filtered.edges).toEqual(graph.edges);
    expect(filterBridgeGraph(withBridge, true)).toBe(withBridge);
    expect(loadBridgeVisibility({ getItem: () => null })).toBe(false);
    expect(loadBridgeVisibility({ getItem: () => "true" })).toBe(true);
  });

  it("focuses exact controller relations and its namespaced topics", () => {
    const controllerGraph: RosGraph = {
      nodes: [
        ...graph.nodes,
        { id: "node:/arm_controller", label: "/arm_controller", kind: "node", types: [] },
        { id: "topic:/arm_controller/state", label: "/arm_controller/state", kind: "topic", types: [] },
        { id: "topic:/other/state", label: "/other/state", kind: "topic", types: [] },
      ],
      edges: [...graph.edges, { source: "node:/arm_controller", target: "topic:/arm_controller/state", relation: "publish" }],
    };
    const focus = controllerGraphFocus(controllerGraph, "arm_controller");
    expect(focus.nodes).toEqual(new Set(["node:/arm_controller", "topic:/arm_controller/state"]));
    expect(focus.edges).toContain(graphEdgeKey(controllerGraph.edges.at(-1)!));
    expect(focus.nodes.has("topic:/other/state")).toBe(false);
  });

});
