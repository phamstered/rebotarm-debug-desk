import type { RosGraph, RosGraphEdge, RosGraphNode } from "./types";

export type PositionedGraphNode = RosGraphNode & {
  x: number;
  y: number;
  radius: number;
};

export type GraphLayout = {
  width: number;
  height: number;
  nodes: PositionedGraphNode[];
  edges: RosGraphEdge[];
};

export const GRAPH_BRIDGE_VISIBILITY_KEY = "robot-console-graph-show-bridge";

export function loadBridgeVisibility(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  return storage.getItem(GRAPH_BRIDGE_VISIBILITY_KEY) === "true";
}

export function isBridgeNode(node: RosGraphNode): boolean {
  if (node.kind !== "node") return false;
  const name = node.label.split("/").filter(Boolean).at(-1) ?? "";
  return name === "bridge" || name === "bridge_node" || name.endsWith("_bridge") || name === "easy_debug_bridge";
}

export function graphEdgeKey(edge: RosGraphEdge): string {
  return `${edge.source}\0${edge.target}\0${edge.relation}`;
}

export function filterBridgeGraph(graph: RosGraph, showBridge: boolean): RosGraph {
  if (showBridge) return graph;
  const hiddenNodes = new Set(graph.nodes.filter(isBridgeNode).map((node) => node.id));
  const hiddenTopics = new Set(graph.nodes.filter((node) => node.kind === "topic" && node.label.split("/").some((segment) => /(?:^bridge$|_bridge$|^easy_debug_bridge$)/.test(segment))).map((node) => node.id));
  const visible = new Set(graph.nodes.filter((node) => !hiddenNodes.has(node.id) && !hiddenTopics.has(node.id)).map((node) => node.id));
  return { nodes: graph.nodes.filter((node) => visible.has(node.id)), edges: graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)) };
}

export function controllerGraphFocus(graph: RosGraph, controllerName: string): { nodes: Set<string>; edges: Set<string> } {
  const normalized = `/${controllerName.replace(/^\/+|\/+$/g, "")}`;
  const exactNodes = graph.nodes.filter((node) => node.kind === "node" && node.label === normalized);
  const basenameNodes = graph.nodes.filter((node) => node.kind === "node" && node.label.split("/").at(-1) === normalized.slice(1));
  const matchedNodes = exactNodes.length ? exactNodes : basenameNodes.length === 1 ? basenameNodes : [];
  const seeds = new Set([
    ...matchedNodes.map((node) => node.id),
    ...graph.nodes.filter((node) => node.kind === "topic" && node.label.startsWith(`${normalized}/`)).map((node) => node.id),
  ]);
  const nodes = new Set(seeds);
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (seeds.has(edge.source) || seeds.has(edge.target)) {
      nodes.add(edge.source);
      nodes.add(edge.target);
      edges.add(graphEdgeKey(edge));
    }
  }
  return { nodes, edges };
}

export function layoutRosGraph(graph: RosGraph, viewport: { width: number; height: number } = { width: 1200, height: 560 }): GraphLayout {
  const nodeCount = graph.nodes.length;
  const width = Math.max(680, Math.round(viewport.width), Math.ceil(Math.sqrt(nodeCount) * 158));
  const height = Math.max(560, Math.round(viewport.height), Math.ceil(Math.sqrt(nodeCount) * 120));
  const neighbors = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  graph.edges.forEach(({ source, target }) => {
    neighbors.get(source)?.add(target);
    neighbors.get(target)?.add(source);
  });
  const sorted = [...graph.nodes].sort((a, b) =>
    (neighbors.get(b.id)?.size ?? 0) - (neighbors.get(a.id)?.size ?? 0) || a.id.localeCompare(b.id));
  const positioned: PositionedGraphNode[] = sorted.map((node, index) => {
    const degree = neighbors.get(node.id)?.size ?? 0;
    const radius = Math.min(58, (node.kind === "node" ? 28 : 22) + Math.sqrt(degree) * 5.5);
    const angle = index * 2.399963229728653;
    const distance = Math.sqrt(index) * 56;
    return {
      ...node,
      x: width / 2 + Math.cos(angle) * distance,
      y: height / 2 + Math.sin(angle) * distance,
      radius,
    };
  });
  const indexById = new Map(positioned.map((node, index) => [node.id, index]));
  const links = graph.edges.flatMap((edge) => {
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    return source === undefined || target === undefined ? [] : [{ source, target }];
  });
  const velocity = positioned.map(() => ({ x: 0, y: 0 }));
  const padding = 26;
  const constrain = (node: PositionedGraphNode) => {
    node.x = Math.max(node.radius + padding, Math.min(width - node.radius - padding, node.x));
    node.y = Math.max(node.radius + padding, Math.min(height - node.radius - padding, node.y));
  };

  // Deterministic force simulation: every refresh and resize converges from the same graph.
  for (let iteration = 0; iteration < 190; iteration += 1) {
    const forces = positioned.map((node) => ({
      x: (width / 2 - node.x) * 0.0018,
      y: (height / 2 - node.y) * 0.0018,
    }));
    for (let i = 0; i < positioned.length; i += 1) {
      for (let j = i + 1; j < positioned.length; j += 1) {
        const a = positioned[i]!;
        const b = positioned[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const separation = a.radius + b.radius + 12;
        const repulsion = 6800 / (distance * distance) + Math.max(0, separation - distance) * 0.13;
        const fx = dx / distance * repulsion;
        const fy = dy / distance * repulsion;
        forces[i]!.x -= fx; forces[i]!.y -= fy;
        forces[j]!.x += fx; forces[j]!.y += fy;
      }
    }
    for (const { source, target } of links) {
      const a = positioned[source]!;
      const b = positioned[target]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const spring = (distance - a.radius - b.radius - 78) * 0.014;
      const fx = dx / distance * spring;
      const fy = dy / distance * spring;
      forces[source]!.x += fx; forces[source]!.y += fy;
      forces[target]!.x -= fx; forces[target]!.y -= fy;
    }
    positioned.forEach((node, index) => {
      const motion = velocity[index]!;
      motion.x = Math.max(-9, Math.min(9, (motion.x + forces[index]!.x) * 0.74));
      motion.y = Math.max(-9, Math.min(9, (motion.y + forces[index]!.y) * 0.74));
      node.x += motion.x;
      node.y += motion.y;
      constrain(node);
    });
  }
  // The final collision pass keeps labels and circles from overlapping.
  for (let iteration = 0; iteration < 40; iteration += 1) {
    let moved = false;
    for (let i = 0; i < positioned.length; i += 1) {
      for (let j = i + 1; j < positioned.length; j += 1) {
        const a = positioned[i]!;
        const b = positioned[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.max(0.001, Math.hypot(dx, dy));
        const overlap = a.radius + b.radius + 5 - distance;
        if (overlap <= 0) continue;
        const shift = overlap / 2 + 0.01;
        a.x -= dx / distance * shift; a.y -= dy / distance * shift;
        b.x += dx / distance * shift; b.y += dy / distance * shift;
        constrain(a); constrain(b);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { width, height, nodes: positioned, edges: graph.edges };
}
