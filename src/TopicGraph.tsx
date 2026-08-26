import { useEffect, useMemo, useState } from "react";
import type { BridgeClient } from "./bridge";
import { layoutRosGraph } from "./topicGraphLogic";
import type { PositionedGraphNode } from "./topicGraphLogic";
import type { RosGraph, TopicInfo } from "./types";

const EMPTY_GRAPH: RosGraph = { nodes: [], edges: [] };
const GRAPH_REFRESH_INTERVAL_MS = 30_000;

function graphLabel(value: string): string {
  return value.length > 31 ? `…${value.slice(-30)}` : value;
}

export function TopicGraph({
  bridge,
  onSelectTopic,
}: {
  bridge: BridgeClient;
  onSelectTopic(topic: TopicInfo): void;
}) {
  const [graph, setGraph] = useState<RosGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [focusedId, setFocusedId] = useState("");
  const layout = useMemo(() => layoutRosGraph(graph), [graph]);
  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes]);
  const relatedIds = useMemo(() => {
    const result = new Set<string>(focusedId ? [focusedId] : []);
    layout.edges.forEach((edge) => {
      if (edge.source === focusedId) result.add(edge.target);
      if (edge.target === focusedId) result.add(edge.source);
    });
    return result;
  }, [focusedId, layout.edges]);

  const refresh = async () => {
    setLoading(true);
    try {
      setGraph(await bridge.getGraph());
      setGraphError("");
    } catch (reason) {
      setGraphError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), GRAPH_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [bridge]);

  const activateNode = (node: PositionedGraphNode) => {
    setFocusedId((current) => current === node.id ? "" : node.id);
    if (node.kind === "topic" && node.types[0]) onSelectTopic({ name: node.label, types: node.types });
  };

  const edgePath = (source: PositionedGraphNode, target: PositionedGraphNode) => {
    const direction = target.x >= source.x ? 1 : -1;
    const startX = source.x + direction * source.width / 2;
    const endX = target.x - direction * target.width / 2;
    const bend = Math.max(45, Math.abs(endX - startX) * 0.42);
    return `M ${startX} ${source.y} C ${startX + direction * bend} ${source.y}, ${endX - direction * bend} ${target.y}, ${endX} ${target.y}`;
  };

  return (
    <div className="topic-graph-view">
      <div className="graph-toolbar">
        <span>{graph.nodes.filter((node) => node.kind === "node").length} Nodes · {graph.nodes.filter((node) => node.kind === "topic").length} Topics · 点击节点聚焦连接</span>
        <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "刷新中…" : "刷新 Graph"}</button>
      </div>
      {graphError && <div className="graph-error">Graph 加载失败：{graphError}</div>}
      <div className="graph-canvas-scroll">
        {graph.nodes.length === 0 && !loading && !graphError && <div className="graph-empty">ROS Graph 暂无节点</div>}
        <svg className="graph-canvas" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} aria-label="ROS Topic Graph">
          <defs>
            <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 8 4 L 0 8 z" /></marker>
          </defs>
          {layout.edges.map((edge, index) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            const related = !focusedId || edge.source === focusedId || edge.target === focusedId;
            const focusClass = !focusedId ? "" : related ? "related" : "dimmed";
            return source && target ? <path key={`${edge.source}-${edge.target}-${index}`} className={`graph-edge ${edge.relation} ${focusClass}`} d={edgePath(source, target)} markerEnd="url(#graph-arrow)" /> : null;
          })}
          {layout.nodes.map((node) => (
            <g
              key={node.id}
              className={`graph-node ${node.kind} ${focusedId === node.id ? "selected" : ""} ${focusedId && !relatedIds.has(node.id) ? "dimmed" : ""}`}
              transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
              role="button"
              tabIndex={0}
              aria-label={node.kind === "topic" ? `Topic ${node.label}` : `Node ${node.label}`}
              onClick={() => activateNode(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") activateNode(node);
              }}
            >
              {node.kind === "topic" ? <ellipse cx={node.width / 2} cy={node.height / 2} rx={node.width / 2} ry={node.height / 2} /> : <rect width={node.width} height={node.height} rx="7" />}
              <text x={node.width / 2} y={node.height / 2 + 4} textAnchor="middle">{graphLabel(node.label)}</text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
