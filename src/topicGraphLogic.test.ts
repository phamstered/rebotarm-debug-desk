import { describe, expect, it } from "vitest";
import { layoutRosGraph } from "./topicGraphLogic";
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

describe("rqt-style topic graph layout", () => {
  it("places publishers, topics and subscribers into directed columns", () => {
    const layout = layoutRosGraph(graph);
    expect(layout.nodes.find((node) => node.id === "node:/driver")?.x).toBeLessThan(600);
    expect(layout.nodes.find((node) => node.id === "topic:/joint_states")?.x).toBe(600);
    expect(layout.nodes.find((node) => node.id === "node:/viewer")?.x).toBeGreaterThan(600);
    expect(layout.edges).toEqual(graph.edges);
  });

  it("uses barycentric sweeps to remove a crossing caused by alphabetical order", () => {
    const crossed: RosGraph = {
      nodes: [
        { id: "node:/a_driver", label: "/a_driver", kind: "node", types: [] },
        { id: "node:/z_driver", label: "/z_driver", kind: "node", types: [] },
        { id: "topic:/a_topic", label: "/a_topic", kind: "topic", types: ["std_msgs/msg/String"] },
        { id: "topic:/z_topic", label: "/z_topic", kind: "topic", types: ["std_msgs/msg/String"] },
      ],
      edges: [
        { source: "node:/a_driver", target: "topic:/z_topic", relation: "publish" },
        { source: "node:/z_driver", target: "topic:/a_topic", relation: "publish" },
      ],
    };
    const layout = layoutRosGraph(crossed);
    const y = new Map(layout.nodes.map((node) => [node.id, node.y]));
    const sourceDelta = y.get("node:/a_driver")! - y.get("node:/z_driver")!;
    const targetDelta = y.get("topic:/z_topic")! - y.get("topic:/a_topic")!;
    expect(sourceDelta * targetDelta).toBeGreaterThan(0);
  });

});
