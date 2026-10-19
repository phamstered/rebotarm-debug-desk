import type { RosGraph, RosGraphEdge, RosGraphNode } from "./types";

export type PositionedGraphNode = RosGraphNode & {
  x: number;
  y: number;
  radius: number;
};

export type GraphLayout = {
  nodes: PositionedGraphNode[];
  edges: RosGraphEdge[];
};

export const GRAPH_BRIDGE_VISIBILITY_KEY = "robot-console-graph-show-bridge";
const GRAPH_LABEL_MAX_CHARS = 20;
const GRAPH_LABEL_LINE_CHARS = 10;

export function graphLabelLines(value: string): string[] {
  const characters = Array.from(value);
  const visible = characters.slice(0, GRAPH_LABEL_MAX_CHARS);
  if (visible.length <= GRAPH_LABEL_LINE_CHARS) return [visible.join("")];
  return [
    visible.slice(0, GRAPH_LABEL_LINE_CHARS).join(""),
    `${visible.slice(GRAPH_LABEL_LINE_CHARS).join("")}${characters.length > GRAPH_LABEL_MAX_CHARS ? "…" : ""}`,
  ];
}

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
    const longestLine = Math.max(...graphLabelLines(node.label).map((line) => Array.from(line).length));
    const labelRadius = Math.ceil(longestLine * 3.1 + 10);
    const radius = Math.max(labelRadius, Math.min(58, (node.kind === "node" ? 28 : 22) + Math.sqrt(degree) * 5.5));
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
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { nodes: positioned, edges: graph.edges };
}

export type ManualGraphPositions = Record<string, { x: number; y: number }>;

/** Placeholder Hz until Bridge / subscribed stats wire real rates: publish flows faster than subscribe. */
export function fakeEdgeFlowHz(relation: RosGraphEdge["relation"]): number {
  return relation === "publish" ? 36 : 16;
}

export function applyManualPositions(
  nodes: PositionedGraphNode[],
  manual: ManualGraphPositions,
): PositionedGraphNode[] {
  return nodes.map((node) => {
    const override = manual[node.id];
    if (!override) return node;
    return { ...node, x: override.x, y: override.y };
  });
}

export function pruneManualPositions(manual: ManualGraphPositions, nodeIds: Iterable<string>): ManualGraphPositions {
  const keep = new Set(nodeIds);
  const next: ManualGraphPositions = {};
  for (const [id, point] of Object.entries(manual)) {
    if (keep.has(id)) next[id] = point;
  }
  return next;
}

export function edgeAnchorSegment(
  source: PositionedGraphNode,
  target: PositionedGraphNode,
): { x1: number; y1: number; x2: number; y2: number; length: number } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  const topicAnchor = (node: PositionedGraphNode) =>
    1 / Math.sqrt((ux / node.radius) ** 2 + (uy / (node.radius * 0.65)) ** 2);
  const nodeAnchor = (node: PositionedGraphNode) =>
    Math.min(node.radius / Math.max(0.001, Math.abs(ux)), (node.radius * 0.68) / Math.max(0.001, Math.abs(uy)));
  const from = source.kind === "topic" ? topicAnchor(source) : nodeAnchor(source);
  const to = (target.kind === "topic" ? topicAnchor(target) : nodeAnchor(target)) + 5;
  const x1 = source.x + ux * from;
  const y1 = source.y + uy * from;
  const x2 = target.x - ux * to;
  const y2 = target.y - uy * to;
  return { x1, y1, x2, y2, length: Math.max(1, Math.hypot(x2 - x1, y2 - y1)) };
}

export function particleOffsets(count: number, progress: number): number[] {
  return Array.from({ length: count }, (_, index) => (progress + index / count) % 1);
}

export function pointAlongSegment(
  segment: { x1: number; y1: number; x2: number; y2: number },
  t: number,
): { x: number; y: number } {
  const clamped = ((t % 1) + 1) % 1;
  return {
    x: segment.x1 + (segment.x2 - segment.x1) * clamped,
    y: segment.y1 + (segment.y2 - segment.y1) * clamped,
  };
}

export function flowParticlesForEdge(
  source: PositionedGraphNode,
  target: PositionedGraphNode,
  relation: RosGraphEdge["relation"],
  nowMs: number,
): { x: number; y: number; hz: number }[] {
  const hz = fakeEdgeFlowHz(relation);
  const segment = edgeAnchorSegment(source, target);
  // Higher Hz → particles lap the edge faster (units: cycles per second along the segment).
  const cyclesPerSecond = Math.max(0.15, hz / 48);
  const progress = (nowMs / 1000) * cyclesPerSecond;
  const count = relation === "publish" ? 4 : 3;
  return particleOffsets(count, progress).map((offset) => ({ ...pointAlongSegment(segment, offset), hz }));
}

export type GraphCamera = { scale: number; tx: number; ty: number };

export const GRAPH_CAMERA_MIN_SCALE = 0.25;
export const GRAPH_CAMERA_MAX_SCALE = 3;

export function clampCameraScale(scale: number): number {
  return Math.min(GRAPH_CAMERA_MAX_SCALE, Math.max(GRAPH_CAMERA_MIN_SCALE, scale));
}

export function screenToWorld(camera: GraphCamera, screen: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (screen.x - camera.tx) / camera.scale,
    y: (screen.y - camera.ty) / camera.scale,
  };
}

export function zoomCameraAt(camera: GraphCamera, screen: { x: number; y: number }, nextScale: number): GraphCamera {
  const scale = Math.min(GRAPH_CAMERA_MAX_SCALE, Math.max(Math.min(GRAPH_CAMERA_MIN_SCALE, camera.scale), nextScale));
  const world = screenToWorld(camera, screen);
  return { scale, tx: screen.x - world.x * scale, ty: screen.y - world.y * scale };
}

export function panCamera(camera: GraphCamera, dx: number, dy: number): GraphCamera {
  return { ...camera, tx: camera.tx + dx, ty: camera.ty + dy };
}

export function fitCameraToNodes(
  nodes: Array<{ x: number; y: number; radius: number }>,
  viewport: { width: number; height: number },
  padding = 48,
): GraphCamera {
  if (nodes.length === 0) return { scale: 1, tx: 0, ty: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const horizontalPadding = Math.min(padding, viewport.width * 0.15);
  const verticalPadding = Math.min(padding, viewport.height * 0.15);
  const scale = Math.min(
    GRAPH_CAMERA_MAX_SCALE,
    (viewport.width - horizontalPadding * 2) / width,
    (viewport.height - verticalPadding * 2) / height,
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    scale,
    tx: viewport.width / 2 - cx * scale,
    ty: viewport.height / 2 - cy * scale,
  };
}

export function resetCamera(
  viewport: { width: number; height: number },
  nodes: Array<{ x: number; y: number; radius: number }>,
): GraphCamera {
  if (nodes.length === 0) return { scale: 1, tx: 0, ty: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }
  return {
    scale: 1,
    tx: viewport.width / 2 - (minX + maxX) / 2,
    ty: viewport.height / 2 - (minY + maxY) / 2,
  };
}

export function centerCameraOn(
  camera: GraphCamera,
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): GraphCamera {
  return {
    ...camera,
    tx: viewport.width / 2 - point.x * camera.scale,
    ty: viewport.height / 2 - point.y * camera.scale,
  };
}
