import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { BridgeClient } from "./bridge";
import {
  applyManualPositions,
  centerCameraOn,
  controllerGraphFocus,
  edgeAnchorSegment,
  filterBridgeGraph,
  fitCameraToNodes,
  flowParticlesForEdge,
  graphEdgeKey,
  graphLabelLines,
  GRAPH_BRIDGE_VISIBILITY_KEY,
  layoutRosGraph,
  loadBridgeVisibility,
  panCamera,
  pruneManualPositions,
  resetCamera,
  screenToWorld,
  zoomCameraAt,
  type GraphCamera,
  type ManualGraphPositions,
  type PositionedGraphNode,
} from "./topicGraphLogic";
import type { RosGraph, TopicInfo } from "./types";

const EMPTY_GRAPH: RosGraph = { nodes: [], edges: [] };
const GRAPH_REFRESH_INTERVAL_MS = 30_000;
const DRAG_CLICK_SLOP_PX = 4;
const DEFAULT_CAMERA: GraphCamera = { scale: 1, tx: 0, ty: 0 };

function clientToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  try {
    const ctm = svg.getScreenCTM?.();
    if (ctm && typeof svg.createSVGPoint === "function") {
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const local = point.matrixTransform(ctm.inverse());
      return { x: local.x, y: local.y };
    }
  } catch {
    /* jsdom / incomplete SVG matrix support */
  }
  const rect = svg.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
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
  const [manualPositions, setManualPositions] = useState<ManualGraphPositions>({});
  const [camera, setCamera] = useState<GraphCamera>(DEFAULT_CAMERA);
  const [draggingId, setDraggingId] = useState("");
  const [panning, setPanning] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const refreshInFlight = useRef(false);
  const dragRef = useRef<{ id: string; moved: boolean; originX: number; originY: number } | null>(null);
  const panRef = useRef<{ originX: number; originY: number; camera: GraphCamera } | null>(null);
  const suppressClickRef = useRef(false);
  const didFitRef = useRef(false);
  const centeredFocusRef = useRef("");
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const visibleGraph = useMemo(() => filterBridgeGraph(graph, showBridge), [graph, showBridge]);
  const layout = useMemo(() => layoutRosGraph(visibleGraph, viewport), [visibleGraph, viewport]);
  const displayNodes = useMemo(
    () => applyManualPositions(layout.nodes, manualPositions, { width: layout.width, height: layout.height }),
    [layout.nodes, layout.width, layout.height, manualPositions],
  );
  const controllerFocus = useMemo(() => controllerGraphFocus(visibleGraph, focusController), [visibleGraph, focusController]);
  const positions = useMemo(() => new Map(displayNodes.map((node) => [node.id, node])), [displayNodes]);
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

  const visibleNodeIds = useMemo(() => visibleGraph.nodes.map((node) => node.id).join("\0"), [visibleGraph.nodes]);
  useEffect(() => {
    setManualPositions((current) => {
      const next = pruneManualPositions(current, visibleGraph.nodes.map((node) => node.id));
      return Object.keys(next).length === Object.keys(current).length &&
        Object.keys(next).every((id) => next[id] === current[id])
        ? current
        : next;
    });
  }, [visibleNodeIds, visibleGraph.nodes]);

  useEffect(() => {
    if (displayNodes.length === 0) {
      didFitRef.current = false;
      return;
    }
    if (didFitRef.current) return;
    setCamera(fitCameraToNodes(displayNodes, viewport));
    didFitRef.current = true;
  }, [displayNodes, viewport]);

  useEffect(() => {
    if (!focusedId) {
      centeredFocusRef.current = "";
      return;
    }
    if (centeredFocusRef.current === focusedId) return;
    const selected = positions.get(focusedId);
    if (!selected || draggingId || panning) return;
    centeredFocusRef.current = focusedId;
    setCamera((current) => centerCameraOn(current, selected, viewport));
  }, [focusedId, positions, draggingId, panning, viewport]);

  useEffect(() => {
    const target = canvasRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewport((current) =>
        current.width === Math.round(width) && current.height === Math.round(height)
          ? current
          : { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) },
      );
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = (time: number) => {
      setNowMs(time);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
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
    centeredFocusRef.current = node.id;
    setFocusedId(node.id);
    if (node.kind === "topic") onSelectTopic({ name: node.label, types: node.types });
    else onSelectNode?.(node.label);
  };

  const edgePath = (source: PositionedGraphNode, target: PositionedGraphNode) => {
    const { x1, y1, x2, y2 } = edgeAnchorSegment(source, target);
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  };

  const beginDrag = (node: PositionedGraphNode, event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* jsdom */
    }
    dragRef.current = { id: node.id, moved: false, originX: event.clientX, originY: event.clientY };
    centeredFocusRef.current = node.id;
    setDraggingId(node.id);
    setFocusedId(node.id);
  };

  const moveDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    const svg = svgRef.current;
    if (!drag || !svg) return;
    if (!drag.moved) {
      const dist = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY);
      if (dist < DRAG_CLICK_SLOP_PX) return;
      drag.moved = true;
    }
    const screen = clientToSvgPoint(svg, event.clientX, event.clientY);
    const point = screenToWorld(cameraRef.current, screen);
    setManualPositions((current) => ({ ...current, [drag.id]: { x: point.x, y: point.y } }));
  };

  const endDrag = (node: PositionedGraphNode, event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* already released */
    }
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    setDraggingId("");
  };

  const beginPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    if ((event.target as Element).closest?.(".graph-node")) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* jsdom */
    }
    panRef.current = { originX: event.clientX, originY: event.clientY, camera: cameraRef.current };
    setPanning(true);
  };

  const movePan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setCamera(panCamera(pan.camera, event.clientX - pan.originX, event.clientY - pan.originY));
  };

  const endPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!panRef.current) return;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* already released */
    }
    panRef.current = null;
    setPanning(false);
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const screen = clientToSvgPoint(svg, event.clientX, event.clientY);
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    setCamera((current) => zoomCameraAt(current, screen, current.scale * factor));
  };

  const zoomBy = (factor: number) => {
    setCamera((current) =>
      zoomCameraAt(current, { x: viewport.width / 2, y: viewport.height / 2 }, current.scale * factor),
    );
  };

  return (
    <div className="topic-graph-view">
      <div className="graph-toolbar">
        <span>
          {visibleGraph.nodes.filter((node) => node.kind === "node").length} Nodes ·{" "}
          {visibleGraph.nodes.filter((node) => node.kind === "topic").length} Topics · 滚轮缩放 · 拖动画布 · 拖动节点
        </span>
        <div className="graph-camera-tools">
          <button type="button" aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}>−</button>
          <span className="graph-zoom-label">{Math.round(camera.scale * 100)}%</span>
          <button type="button" aria-label="放大" onClick={() => zoomBy(1.2)}>+</button>
          <button type="button" onClick={() => setCamera(fitCameraToNodes(displayNodes, viewport))}>Fit</button>
          <button type="button" onClick={() => setCamera(resetCamera(viewport, layout))}>Reset</button>
        </div>
        <label className="graph-bridge-toggle">
          <input
            type="checkbox"
            checked={showBridge}
            onChange={(event) => {
              setShowBridge(event.target.checked);
              localStorage.setItem(GRAPH_BRIDGE_VISIBILITY_KEY, String(event.target.checked));
            }}
          />
          显示 Bridge
        </label>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "刷新中…" : "刷新 Graph"}
        </button>
      </div>
      {graphError && <div className="graph-error">Graph 加载失败：{graphError}</div>}
      {focusController && controllerFocus.nodes.size === 0 && (
        <div className="graph-error">未在当前 ROS Graph 中找到 Controller {focusController} 的关联节点或 Topic</div>
      )}
      <div className="graph-canvas-scroll" ref={canvasRef}>
        {visibleGraph.nodes.length === 0 && !loading && !graphError && <div className="graph-empty">ROS Graph 暂无节点</div>}
        <svg
          ref={svgRef}
          className={`graph-canvas${draggingId || panning ? " dragging" : ""}${panning ? " panning" : ""}`}
          width={viewport.width}
          height={viewport.height}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          aria-label="ROS Topic Graph"
          onWheel={onWheel}
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        >
          <defs>
            <marker id="graph-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M 0 0 L 6 3 L 0 6 z" />
            </marker>
          </defs>
          <g transform={`translate(${camera.tx} ${camera.ty}) scale(${camera.scale})`}>
            {layout.edges.map((edge, index) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              const activeFocus = focusController && controllerFocus.nodes.size > 0;
              const related = activeFocus
                ? controllerFocus.edges.has(graphEdgeKey(edge))
                : !focusedId || edge.source === focusedId || edge.target === focusedId;
              const focusClass = !activeFocus && !focusedId ? "" : related ? "related" : "dimmed";
              if (!source || !target) return null;
              const particles = focusClass === "dimmed" ? [] : flowParticlesForEdge(source, target, edge.relation, nowMs);
              return (
                <g key={`${edge.source}-${edge.target}-${index}`} className={`graph-edge-group ${edge.relation} ${focusClass}`}>
                  <path className={`graph-edge ${edge.relation} ${focusClass}`} d={edgePath(source, target)} markerEnd="url(#graph-arrow)">
                    <title>{`${source.label} → ${target.label} (${edge.relation})`}</title>
                  </path>
                  {particles.map((particle, particleIndex) => (
                    <circle
                      key={particleIndex}
                      className={`graph-flow-particle ${edge.relation} ${focusClass}`}
                      cx={particle.x}
                      cy={particle.y}
                      r={edge.relation === "publish" ? 2.6 : 2.2}
                      data-hz={particle.hz}
                    />
                  ))}
                </g>
              );
            })}
            {displayNodes.map((node) => (
              <g
                key={node.id}
                className={`graph-node ${node.kind} ${
                  focusedId === node.id || (focusController && controllerFocus.nodes.has(node.id)) ? "selected" : ""
                } ${
                  (focusController && controllerFocus.nodes.size > 0
                    ? !controllerFocus.nodes.has(node.id)
                    : focusedId && !relatedIds.has(node.id))
                    ? "dimmed"
                    : ""
                } ${draggingId === node.id ? "dragging" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={0}
                aria-label={node.kind === "topic" ? `Topic ${node.label}` : `Node ${node.label}`}
                onPointerDown={(event) => beginDrag(node, event)}
                onPointerMove={moveDrag}
                onPointerUp={(event) => endDrag(node, event)}
                onPointerCancel={(event) => endDrag(node, event)}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  activateNode(node);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") activateNode(node);
                }}
              >
                <title>{`${node.kind === "topic" ? "Topic" : "Node"}: ${node.label}`}</title>
                {node.kind === "node" ? (
                  <rect
                    x={-node.radius}
                    y={-node.radius * 0.68}
                    width={node.radius * 2}
                    height={node.radius * 1.36}
                    rx={Math.min(12, node.radius * 0.35)}
                  />
                ) : (
                  <ellipse rx={node.radius} ry={node.radius * 0.65} />
                )}
                <text textAnchor="middle" style={{ fontSize: node.radius >= 30 ? 10 : 9 }}>
                  {graphLabelLines(node.label).map((line, index, lines) => (
                    <tspan key={index} x="0" y={lines.length === 1 ? 3 : index === 0 ? -3 : 8}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
