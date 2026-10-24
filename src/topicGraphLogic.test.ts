import { describe, expect, it } from "vitest";
import { applyManualPositions, centerCameraOn, clampCameraScale, controllerGraphFocus, edgeAnchorSegment, fakeEdgeFlowHz, filterBridgeGraph, fitCameraToNodes, flowParticlesForEdge, graphEdgeKey, graphLabelLines, layoutRosGraph, loadBridgeVisibility, panCamera, pointAlongSegment, pruneManualPositions, resetCamera, screenToWorld, zoomCameraAt } from "./topicGraphLogic";
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
  it("shows up to 20 original label characters including Topic slashes", () => {
    expect(graphLabelLines("/joint_states")).toEqual(["/joint_sta", "tes"]);
    expect(graphLabelLines("/123456789/123456789")).toEqual(["/123456789", "/123456789"]);
    expect(graphLabelLines("/123456789/123456789/extra")).toEqual(["/123456789", "/123456789…"]);
  });

  it("gives a 20-character label enough room inside its node shape", () => {
    const longLabel = "/123456789/123456789";
    const layout = layoutRosGraph({ nodes: [{ id: `topic:${longLabel}`, label: longLabel, kind: "topic", types: [] }], edges: [] });
    expect(layout.nodes[0]!.radius).toBeGreaterThanOrEqual(40);
  });

  it("keeps directed ROS relations and uses circular nodes sized by degree", () => {
    const layout = layoutRosGraph(graph);
    expect(layout.edges).toEqual(graph.edges);
    expect(layout.nodes.find((node) => node.id === "topic:/joint_states")!.radius).toBeGreaterThan(22);
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("separates dense nodes without overlapping circles", () => {
    const dense: RosGraph = {
      nodes: Array.from({ length: 32 }, (_, index) => ({ id: `topic:/arm/topic_${index}`, label: `/arm/topic_${index}`, kind: "topic" as const, types: [] })),
      edges: Array.from({ length: 31 }, (_, index) => ({ source: "topic:/arm/topic_0", target: `topic:/arm/topic_${index + 1}`, relation: "publish" as const })),
    };
    const layout = layoutRosGraph(dense, { width: 500, height: 320 });
    layout.nodes.forEach((node, index) => {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
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

describe("topic graph drag and particle flow helpers", () => {
  it("keeps manual positions outside the initial layout after refresh", () => {
    const layout = layoutRosGraph(graph, { width: 900, height: 600 });
    const driver = layout.nodes.find((node) => node.id === "node:/driver")!;
    const moved = applyManualPositions(layout.nodes, { "node:/driver": { x: 120, y: 140 } });
    expect(moved.find((node) => node.id === "node:/driver")).toMatchObject({ x: 120, y: 140 });
    expect(moved.find((node) => node.id === "topic:/joint_states")!.x).toBe(layout.nodes.find((node) => node.id === "topic:/joint_states")!.x);
    const unbounded = applyManualPositions([driver], { "node:/driver": { x: -500, y: 9999 } });
    expect(unbounded[0]).toMatchObject({ x: -500, y: 9999 });
    expect(fitCameraToNodes(unbounded, { width: 400, height: 300 }).scale).toBeGreaterThan(0);
    expect(pruneManualPositions({ "node:/driver": { x: 1, y: 2 }, "gone": { x: 3, y: 4 } }, ["node:/driver"])).toEqual({ "node:/driver": { x: 1, y: 2 } });
  });

  it("moves placeholder particles along publish edges faster than subscribe", () => {
    expect(fakeEdgeFlowHz("publish")).toBeGreaterThan(fakeEdgeFlowHz("subscribe"));
    const layout = layoutRosGraph(graph);
    const source = layout.nodes.find((node) => node.id === "node:/driver")!;
    const target = layout.nodes.find((node) => node.id === "topic:/joint_states")!;
    const segment = edgeAnchorSegment(source, target);
    expect(pointAlongSegment(segment, 0)).toEqual({ x: segment.x1, y: segment.y1 });
    expect(pointAlongSegment(segment, 0.999).x).toBeCloseTo(segment.x1 + (segment.x2 - segment.x1) * 0.999, 5);
    const mid = pointAlongSegment(segment, 0.5);
    expect(mid.x).toBeCloseTo((segment.x1 + segment.x2) / 2, 5);
    const publish = flowParticlesForEdge(source, target, "publish", 0);
    const later = flowParticlesForEdge(source, target, "publish", 1000);
    expect(publish).toHaveLength(4);
    expect(later[0]!.x).not.toBeCloseTo(publish[0]!.x, 5);
    expect(flowParticlesForEdge(source, target, "subscribe", 0)).toHaveLength(3);
  });
});

describe("graph camera helpers", () => {
  it("clamps zoom and zooms toward the cursor", () => {
    expect(clampCameraScale(0.01)).toBe(0.25);
    expect(clampCameraScale(9)).toBe(3);
    const camera = { scale: 1, tx: 0, ty: 0 };
    const zoomed = zoomCameraAt(camera, { x: 100, y: 50 }, 2);
    expect(zoomed.scale).toBe(2);
    expect(screenToWorld(zoomed, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
    expect(panCamera(camera, 10, -4)).toEqual({ scale: 1, tx: 10, ty: -4 });
  });

  it("fits and resets the camera around layout nodes", () => {
    const nodes = [
      { x: 0, y: 0, radius: 10 },
      { x: 200, y: 100, radius: 10 },
    ];
    const viewport = { width: 400, height: 300 };
    const fitted = fitCameraToNodes(nodes, viewport);
    expect(fitted.scale).toBeGreaterThan(0.25);
    expect(fitted.scale).toBeLessThanOrEqual(3);
    const centered = centerCameraOn({ scale: 1, tx: 0, ty: 0 }, { x: 100, y: 50 }, viewport);
    expect(centered.tx).toBe(100);
    expect(centered.ty).toBe(100);
    expect(resetCamera(viewport, nodes)).toEqual({ scale: 1, tx: 100, ty: 100 });
    const moved = [{ x: -500, y: 800, radius: 10 }, { x: 900, y: -300, radius: 10 }];
    const reset = resetCamera(viewport, moved);
    expect(reset).toEqual({ scale: 1, tx: 0, ty: -100 });
    const far = [{ x: -5000, y: 800, radius: 10 }, { x: 9000, y: -300, radius: 10 }];
    const fit = fitCameraToNodes(far, viewport);
    const left = -5010 * fit.scale + fit.tx;
    const right = 9010 * fit.scale + fit.tx;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(viewport.width);
    expect(fit.scale).toBeLessThan(0.25);
    expect(zoomCameraAt(fit, { x: 200, y: 150 }, fit.scale * 1.1).scale).toBeCloseTo(fit.scale * 1.1);
    const narrow = fitCameraToNodes(nodes, { width: 80, height: 60 });
    expect(0 * narrow.scale + narrow.tx).toBeGreaterThan(0);
    expect(200 * narrow.scale + narrow.tx).toBeLessThan(80);
    expect(resetCamera(viewport, [])).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
});

describe("diagnostic Bridge visibility", () => {
  it("keeps STM32, sensor and user bridge nodes, topics and endpoint edges by default", () => {
    const names = ["/easy_debug_bridge", "/debug/easy_debug_bridge", "/stm32h723_motor_bridge", "/camera_bridge", "/bridge", "/bridge_node"];
    const topics = ["/stm32/joint_states", "/camera_bridge/image", "/bridge/status", "/easy_debug_bridge/status"];
    const source: RosGraph = {
      nodes: [...names.map((label) => ({ id: `node:${label}`, label, kind: "node" as const, types: [] })), ...topics.map((label) => ({ id: `topic:${label}`, label, kind: "topic" as const, types: [] }))],
      edges: [
        { source: "node:/stm32h723_motor_bridge", target: "topic:/stm32/joint_states", relation: "publish" },
        { source: "node:/camera_bridge", target: "topic:/camera_bridge/image", relation: "publish" },
        { source: "node:/easy_debug_bridge", target: "topic:/stm32/joint_states", relation: "subscribe" },
      ],
    };
    const filtered = filterBridgeGraph(source, false);
    expect(filtered.nodes.map((node) => node.label)).toEqual([...names.slice(2), ...topics.slice(0, 3)]);
    expect(filtered.edges).toEqual(source.edges.slice(0, 2));
    expect(filterBridgeGraph(source, true)).toBe(source);
  });
});
