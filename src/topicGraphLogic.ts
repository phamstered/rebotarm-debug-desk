import type { RosGraph, RosGraphEdge, RosGraphNode } from "./types";

export type PositionedGraphNode = RosGraphNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GraphLayout = {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
  edges: RosGraphEdge[];
};

function stableBarycentricSort(
  layer: RosGraphNode[],
  neighbors: Map<string, Set<string>>,
  opposite: RosGraphNode[],
): RosGraphNode[] {
  const positions = new Map(opposite.map((node, index) => [node.id, index]));
  return layer
    .map((node, index) => {
      const connected = [...(neighbors.get(node.id) ?? [])]
        .map((id) => positions.get(id))
        .filter((value): value is number => value !== undefined);
      return { node, index, barycenter: connected.length ? connected.reduce((sum, value) => sum + value, 0) / connected.length : Number.POSITIVE_INFINITY };
    })
    .sort((a, b) => a.barycenter - b.barycenter || a.index - b.index || a.node.label.localeCompare(b.node.label))
    .map(({ node }) => node);
}

function alignedLayer(
  nodes: RosGraphNode[],
  x: number,
  height: number,
  neighbors: Map<string, Set<string>>,
  topicY: Map<string, number>,
): PositionedGraphNode[] {
  const top = 48;
  const bottom = height - 48;
  const gap = nodes.length > 1 ? (bottom - top) / (nodes.length - 1) : 0;
  const desired = nodes.map((node, index) => {
    const values = [...(neighbors.get(node.id) ?? [])]
      .map((id) => topicY.get(id))
      .filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : top + gap * index;
  });
  const minimumGap = 54;
  const placed: number[] = [];
  desired.forEach((value, index) => placed.push(Math.max(value, index ? placed[index - 1] + minimumGap : top)));
  const overflow = Math.max(0, (placed.at(-1) ?? bottom) - bottom);
  const shifted = placed.map((value) => value - overflow);
  const underflow = Math.max(0, top - (shifted[0] ?? top));
  return nodes.map((node, index) => ({
    ...node,
    x,
    y: shifted[index] + underflow,
    width: 220,
    height: 40,
  }));
}

export function layoutRosGraph(graph: RosGraph): GraphLayout {
  let topics = graph.nodes.filter((node) => node.kind === "topic").sort((a, b) => a.label.localeCompare(b.label));
  const rosNodes = graph.nodes.filter((node) => node.kind === "node").sort((a, b) => a.label.localeCompare(b.label));
  const publishCounts = new Map<string, number>();
  const subscribeCounts = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  };
  graph.edges.forEach((edge) => {
    connect(edge.source, edge.target);
    if (edge.relation === "publish") publishCounts.set(edge.source, (publishCounts.get(edge.source) ?? 0) + 1);
    else subscribeCounts.set(edge.target, (subscribeCounts.get(edge.target) ?? 0) + 1);
  });
  let left = rosNodes.filter((node) => (publishCounts.get(node.id) ?? 0) >= (subscribeCounts.get(node.id) ?? 0));
  let right = rosNodes.filter((node) => !left.includes(node));

  // Sugiyama-style crossing reduction: alternate barycentric sweeps over adjacent layers.
  for (let sweep = 0; sweep < 8; sweep += 1) {
    left = stableBarycentricSort(left, neighbors, topics);
    topics = stableBarycentricSort(topics, neighbors, left);
    right = stableBarycentricSort(right, neighbors, topics);
    topics = stableBarycentricSort(topics, neighbors, right);
  }

  const largestLayer = Math.max(topics.length, left.length, right.length, 1);
  const height = Math.max(560, 96 + (largestLayer - 1) * 64);
  const topicGap = topics.length > 1 ? (height - 96) / (topics.length - 1) : 0;
  const positionedTopics: PositionedGraphNode[] = topics.map((node, index) => ({
    ...node,
    x: 600,
    y: 48 + topicGap * index,
    width: 250,
    height: 40,
  }));
  const topicY = new Map(positionedTopics.map((node) => [node.id, node.y]));
  return {
    width: 1200,
    height,
    nodes: [
      ...alignedLayer(left, 140, height, neighbors, topicY),
      ...positionedTopics,
      ...alignedLayer(right, 1060, height, neighbors, topicY),
    ],
    edges: graph.edges,
  };
}
