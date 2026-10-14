import { useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "./bridge";
import { controllerGraphFocus, filterBridgeGraph, graphEdgeKey, GRAPH_BRIDGE_VISIBILITY_KEY, layoutRosGraph, loadBridgeVisibility } from "./topicGraphLogic";
import type { PositionedGraphNode } from "./topicGraphLogic";
import type { RosGraph, TopicInfo } from "./types";

const EMPTY_GRAPH: RosGraph = { nodes: [], edges: [] };
const GRAPH_REFRESH_INTERVAL_MS = 30_000;

function graphLabelLines(value: string, radius: number): string[] {
  const segments = value.split("/").filter(Boolean);
  const limit = Math.max(5, Math.floor(radius / 2.7));
  const shorten = (name: string) => name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
  if (segments.length < 2) return [shorten(segments[0] ?? value)];
  return [shorten(segments.at(-2)!), shorten(segments.at(-1)!)];
}

export function TopicGraph({
  bridge,
  onSelectTopic,
  onSelectNode,
  selectedTopic = "",
  selectedNode = "",
  focusController = "",
  onClearControllerFocus,
}: {
  bridge: BridgeClient;
  onSelectTopic(topic: TopicInfo): void;
  onSelectNode?(node: string): void;
  selectedTopic?: string;
  selectedNode?: string;
  focusController?: string;
  onClearControllerFocus?(): void;
}) {
  const [graph, setGraph] = useState<RosGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [focusedId, setFocusedId] = useState("");
  const [showBridge, setShowBridge] = useState(loadBridgeVisibility);
  const [viewport, setViewport] = useState({ width: 1200, height: 560 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const refreshInFlight = useRef(false);
  const visibleGraph = useMemo(() => filterBridgeGraph(graph, showBridge), [graph, showBridge]);
  const layout = useMemo(() => layoutRosGraph(visibleGraph, viewport), [visibleGraph, viewport]);
  const controllerFocus = useMemo(() => controllerGraphFocus(visibleGraph, focusController), [visibleGraph, focusController]);
  const positions = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes]);
  const relatedIds = useMemo(() => {
    const result = new Set<string>(focusedId ? [focusedId] : []);
    layout.edges.forEach((edge) => {
      if (edge.source === focusedId) result.add(edge.target);
      if (edge.target === focusedId) result.add(edge.source);
    });
    return result;
  }, [focusedId, layout.edges]);

  useEffect(() => {
    setFocusedId(selectedNode ? `node:${selectedNode}` : selectedTopic ? `topic:${selectedTopic}` : "");
  }, [selectedNode, selectedTopic]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const selected = positions.get(focusedId);
    if (!canvas || !selected) return;
    const left = Math.max(0, selected.x - canvas.clientWidth / 2);
    const top = Math.max(0, selected.y - canvas.clientHeight / 2);
    if (typeof canvas.scrollTo === "function") canvas.scrollTo({ left, top, behavior: "smooth" });
    else { canvas.scrollLeft = left; canvas.scrollTop = top; }
  }, [focusedId, positions]);

  useEffect(() => {
    const target = canvasRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewport((current) => current.width === Math.round(width) && current.height === Math.round(height) ? current : { width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const refresh = async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    try {
      setGraph(await bridge.getGraph());
      setGraphError("");
    } catch (reason) {
      setGraphError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), GRAPH_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [bridge]);

  const activateNode = (node: PositionedGraphNode) => {
    onClearControllerFocus?.();
    setFocusedId(node.id);
    if (node.kind === "topic") onSelectTopic({ name: node.label, types: node.types });
    else onSelectNode?.(node.label);
  };

  const anchorDistance = (node: PositionedGraphNode, ux: number, uy: number) => {
    if (node.kind === "topic") {
      return 1 / Math.sqrt((ux / node.radius) ** 2 + (uy / (node.radius * 0.65)) ** 2);
    }
    return Math.min(node.radius / Math.max(0.001, Math.abs(ux)), node.radius * 0.68 / Math.max(0.001, Math.abs(uy)));
  };

  const edgePath = (source: PositionedGraphNode, target: PositionedGraphNode) => {
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / distance;
    const uy = dy / distance;
    const from = anchorDistance(source, ux, uy);
    const to = anchorDistance(target, ux, uy) + 5;
    return `M ${source.x + ux * from} ${source.y + uy * from} L ${target.x - ux * to} ${target.y - uy * to}`;
  };

  return (
    <div className="topic-graph-view">
      <div className="graph-toolbar">
        <span>{visibleGraph.nodes.filter((node) => node.kind === "node").length} Nodes · {visibleGraph.nodes.filter((node) => node.kind === "topic").length} Topics · 图形越大连接越多 · 点击聚焦</span>
        <label className="graph-bridge-toggle"><input type="checkbox" checked={showBridge} onChange={(event) => { setShowBridge(event.target.checked); localStorage.setItem(GRAPH_BRIDGE_VISIBILITY_KEY, String(event.target.checked)); }} />显示 Bridge</label>
        <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "刷新中…" : "刷新 Graph"}</button>
      </div>
      {graphError && <div className="graph-error">Graph 加载失败：{graphError}</div>}
      {focusController && controllerFocus.nodes.size === 0 && <div className="graph-error">未在当前 ROS Graph 中找到 Controller {focusController} 的关联节点或 Topic</div>}
      <div className="graph-canvas-scroll" ref={canvasRef}>
        {visibleGraph.nodes.length === 0 && !loading && !graphError && <div className="graph-empty">ROS Graph 暂无节点</div>}
        <svg className="graph-canvas" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} aria-label="ROS Topic Graph">
          <defs>
            <marker id="graph-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M 0 0 L 6 3 L 0 6 z" /></marker>
          </defs>
          {layout.edges.map((edge, index) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            const activeFocus = focusController && controllerFocus.nodes.size > 0;
            const related = activeFocus ? controllerFocus.edges.has(graphEdgeKey(edge)) : !focusedId || edge.source === focusedId || edge.target === focusedId;
            const focusClass = !activeFocus && !focusedId ? "" : related ? "related" : "dimmed";
            return source && target ? <path key={`${edge.source}-${edge.target}-${index}`} className={`graph-edge ${edge.relation} ${focusClass}`} d={edgePath(source, target)} markerEnd="url(#graph-arrow)"><title>{`${source.label} → ${target.label} (${edge.relation})`}</title></path> : null;
          })}
          {layout.nodes.map((node) => (
            <g
              key={node.id}
              className={`graph-node ${node.kind} ${focusedId === node.id || (focusController && controllerFocus.nodes.has(node.id)) ? "selected" : ""} ${(focusController && controllerFocus.nodes.size > 0 ? !controllerFocus.nodes.has(node.id) : focusedId && !relatedIds.has(node.id)) ? "dimmed" : ""}`}
              transform={`translate(${node.x} ${node.y})`}
              role="button"
              tabIndex={0}
              aria-label={node.kind === "topic" ? `Topic ${node.label}` : `Node ${node.label}`}
              onClick={() => activateNode(node)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") activateNode(node);
              }}
            >
              <title>{`${node.kind === "topic" ? "Topic" : "Node"}: ${node.label}`}</title>
              {node.kind === "node"
                ? <rect x={-node.radius} y={-node.radius * 0.68} width={node.radius * 2} height={node.radius * 1.36} rx={Math.min(12, node.radius * 0.35)} />
                : <ellipse rx={node.radius} ry={node.radius * 0.65} />}
              <text textAnchor="middle" style={{ fontSize: node.radius >= 30 ? 10 : 9 }}>
                {graphLabelLines(node.label, node.radius).map((line, index, lines) => <tspan key={index} x="0" y={lines.length === 1 ? 3 : index === 0 ? -3 : 8}>{line}</tspan>)}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
