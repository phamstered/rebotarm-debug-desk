import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from "react";
import type { TopicSample } from "./appLogic";
import type { BridgeClient } from "./bridge";
import { imageMetadataJson, isRosImageType } from "./imageTopicLogic";
import { RosImagePreview } from "./RosImagePreview";
import type { NodeDetails, TopicDetails, TopicEndpointInfo, TopicInfo } from "./types";

type JsonLine = { indent: number; content: ReactNode };

function numericArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function pathFor(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;
}

function jsonLines(value: unknown): JsonLine[] {
  const lines: JsonLine[] = [];
  const walk = (item: unknown, path: string, indent: number, label = "", comma = "") => {
    const monitorable = (typeof item === "number" && Number.isFinite(item)) || numericArray(item);
    const prefix = label ? <span className={monitorable ? "json-numeric" : ""} data-monitor-path={monitorable ? path : undefined}>{JSON.stringify(label)}: </span> : null;
    if (Array.isArray(item)) {
      lines.push({ indent, content: <>{prefix}<span className={monitorable ? "json-numeric" : ""} data-monitor-path={monitorable ? path : undefined}>[</span></> });
      item.forEach((child, index) => walk(child, pathFor(path, index), indent + 1, "", index < item.length - 1 ? "," : ""));
      lines.push({ indent, content: `]${comma}` });
    } else if (item && typeof item === "object") {
      lines.push({ indent, content: <>{prefix}{"{"}</> });
      const entries = Object.entries(item);
      entries.forEach(([key, child], index) => walk(child, pathFor(path, key), indent + 1, key, index < entries.length - 1 ? "," : ""));
      lines.push({ indent, content: `}${comma}` });
    } else {
      const display = JSON.stringify(item) ?? "null";
      lines.push({ indent, content: <>{prefix}<span className={monitorable ? "json-numeric" : ""} data-monitor-path={monitorable ? path : undefined}>{display}</span>{comma}</> });
    }
  };
  walk(value, "", 0);
  return lines;
}

function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return <div className="inspector-detail-field"><dt>{label}</dt><dd>{value}</dd></div>;
}

function EndpointCard({ endpoint }: { endpoint: TopicEndpointInfo }) {
  const qos = endpoint.qos;
  const depth = qos.history === "KEEP_LAST" ? `${qos.history} (${qos.depth})` : qos.history;
  return <article className="inspector-endpoint">
    <strong>{endpoint.node_namespace === "/" ? `/${endpoint.node_name}` : `${endpoint.node_namespace.replace(/\/$/, "")}/${endpoint.node_name}`}</strong>
    <dl>
      <DetailField label="Node name" value={endpoint.node_name} />
      <DetailField label="Node namespace" value={endpoint.node_namespace} />
      <DetailField label="Topic type" value={endpoint.topic_type} />
      <DetailField label="Endpoint type" value={endpoint.endpoint_type} />
      <DetailField label="GID" value={endpoint.gid} />
      <DetailField label="Reliability" value={qos.reliability} />
      <DetailField label="History (Depth)" value={depth} />
      <DetailField label="Durability" value={qos.durability} />
      <DetailField label="Lifespan" value={qos.lifespan} />
      <DetailField label="Deadline" value={qos.deadline} />
      <DetailField label="Liveliness" value={qos.liveliness} />
      <DetailField label="Liveliness lease duration" value={qos.liveliness_lease_duration} />
    </dl>
  </article>;
}

function NodeResourceList({ title, entries }: { title: string; entries: TopicInfo[] }) {
  return <section className="inspector-detail-section">
    <h3>{title} <span>{entries.length}</span></h3>
    {entries.length ? <ul>{entries.map((entry) => <li key={entry.name}><strong>{entry.name}</strong><small>{entry.types.join(", ") || "类型未知"}</small></li>)}</ul> : <p>无</p>}
  </section>;
}

export function TopicInspector({
  bridge,
  selected,
  selectedNode = "",
  topicType = "",
  sample,
  subscribeError = "",
  monitorPanels = [],
  selectedMonitorPanelId = "",
  onAddToDataGraph,
  onDataVisibilityChange,
}: {
  bridge?: Pick<BridgeClient, "getTopicInfo" | "getNodeInfo">;
  selected: string;
  selectedNode?: string;
  topicType?: string;
  sample: TopicSample | undefined;
  subscribeError?: string;
  monitorPanels?: Array<{ id: string; name: string; panels?: Array<{ id: string; title: string }> }>;
  selectedMonitorPanelId?: string;
  onAddToDataGraph?(fieldPath: string, dashboardId: string, panelId: string | null): void;
  onDataVisibilityChange?(visible: boolean): void;
}) {
  const imageTopic = isRosImageType(topicType);
  const [tab, setTab] = useState<"data" | "details">("data");
  useEffect(() => { onDataVisibilityChange?.(tab === "data" && !selectedNode); }, [tab, selectedNode, onDataVisibilityChange]);
  const [topicDetails, setTopicDetails] = useState<TopicDetails | null>(null);
  const [nodeDetails, setNodeDetails] = useState<NodeDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsRevision, setDetailsRevision] = useState(0);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number; dashboardId: string | null } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const panelNameCounts = new Map<string, number>();
  monitorPanels.forEach((panel) => panelNameCounts.set(panel.name, (panelNameCounts.get(panel.name) ?? 0) + 1));
  const panelOrdinal = new Map<string, number>();
  const lines = useMemo(() => selected && !selectedNode && sample && !imageTopic ? jsonLines(sample.data) : [], [imageTopic, sample, selected, selectedNode]);
  useEffect(() => {
    setMenu(null);
    setTopicDetails(null);
    setNodeDetails(null);
    setDetailsError("");
    setTab(selectedNode ? "details" : "data");
  }, [selected, selectedNode]);
  useEffect(() => {
    if (!bridge || tab !== "details" || (!selected && !selectedNode)) return;
    let active = true;
    setDetailsLoading(true);
    setDetailsError("");
    const request = selectedNode ? bridge.getNodeInfo(selectedNode) : bridge.getTopicInfo(selected);
    void request.then((details) => {
      if (!active) return;
      if (selectedNode) setNodeDetails(details as NodeDetails);
      else setTopicDetails(details as TopicDetails);
    }).catch((reason: unknown) => {
      if (active) setDetailsError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setDetailsLoading(false); });
    return () => { active = false; };
  }, [bridge, selected, selectedNode, tab, detailsRevision]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", escape); };
  }, [menu]);
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu?.dashboardId, menu?.path]);
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menu) return;
    if (event.key === "ArrowLeft" && menu.dashboardId) {
      event.preventDefault();
      setMenu({ ...menu, dashboardId: null });
    } else if (event.key === "ArrowRight" && !menu.dashboardId) {
      const dashboardId = (document.activeElement as HTMLElement | null)?.dataset.dashboardId;
      if (dashboardId) { event.preventDefault(); setMenu({ ...menu, dashboardId }); }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
    }
  };
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!onAddToDataGraph || selectedNode || tab !== "data") return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-monitor-path]");
    const path = target?.dataset.monitorPath;
    if (!path) return;
    event.preventDefault();
    const menuHeight = Math.min(320, 68 + Math.max(monitorPanels.length, ...monitorPanels.map((dashboard) => dashboard.panels?.length ?? 0)) * 30);
    setMenu({ path, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)), dashboardId: null });
  };
  return (
    <div className="section-content topic-inspector-content">
      {(selected || selectedNode) && <div className="topic-inspector-status"><strong title={selectedNode || selected}>{selectedNode || selected}</strong><span>{selectedNode ? "ROS Node" : imageTopic ? "图像预览 + 元数据" : "ROS Topic"}</span></div>}
      <div className="inspector-tabs" role="tablist" aria-label="Inspector 视图">
        <button type="button" role="tab" aria-selected={tab === "data"} disabled={Boolean(selectedNode)} onClick={() => setTab("data")}>数据</button>
        <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>详情</button>
      </div>
      {tab === "data" && <>
        {subscribeError && <div className="topic-inspector-error">订阅失败：{subscribeError}</div>}
        {imageTopic && <RosImagePreview data={sample?.data} />}
        {imageTopic ? <pre>{imageMetadataJson(sample?.data)}</pre> : !selected || !sample ? <pre>{selected ? JSON.stringify("等待数据…", null, 2) : "从左侧或 Topic Graph 选择一个 Topic"}</pre> : (
          <pre className="json-inspector" onContextMenu={openMenu} aria-label="Topic JSON">
            {lines.map((line, index) => <div key={index} style={{ paddingLeft: `${line.indent * 16}px` }}>{line.content}</div>)}
          </pre>
        )}
      </>}
      {tab === "details" && <div className="inspector-details" aria-label="ROS 详情">
        <div className="inspector-details-toolbar"><span>当前 ROS Graph 详情</span><button type="button" disabled={detailsLoading || (!selected && !selectedNode)} onClick={() => setDetailsRevision((value) => value + 1)}>刷新详情</button></div>
        {detailsLoading && <p className="inspector-detail-message">读取中…</p>}
        {detailsError && <p className="inspector-detail-message error">详情读取失败：{detailsError}</p>}
        {!bridge && <p className="inspector-detail-message">详情暂不可用</p>}
        {!selected && !selectedNode && <p className="inspector-detail-message">从左侧或 Topic Graph 选择一个 Topic 或 Node</p>}
        {!selectedNode && topicDetails?.name === selected && <>
          <dl className="inspector-detail-summary"><DetailField label="Topic" value={topicDetails.name} /><DetailField label="Type" value={topicDetails.types.join(", ") || "类型未知"} /></dl>
          <section className="inspector-detail-section"><h3>Publishers <span>{topicDetails.publishers.length}</span></h3>{topicDetails.publishers.length ? topicDetails.publishers.map((endpoint) => <EndpointCard key={`${endpoint.gid}:publisher`} endpoint={endpoint} />) : <p>无</p>}</section>
          <section className="inspector-detail-section"><h3>Subscriptions <span>{topicDetails.subscriptions.length}</span></h3>{topicDetails.subscriptions.length ? topicDetails.subscriptions.map((endpoint) => <EndpointCard key={`${endpoint.gid}:subscription`} endpoint={endpoint} />) : <p>无</p>}</section>
        </>}
        {selectedNode && nodeDetails?.name === selectedNode && <>
          <dl className="inspector-detail-summary"><DetailField label="Node" value={nodeDetails.name} /><DetailField label="Namespace" value={nodeDetails.namespace} /></dl>
          <NodeResourceList title="Publishers" entries={nodeDetails.publishers} />
          <NodeResourceList title="Subscriptions" entries={nodeDetails.subscriptions} />
          <NodeResourceList title="Services" entries={nodeDetails.services} />
          <NodeResourceList title="Clients" entries={nodeDetails.clients} />
        </>}
      </div>}
      {menu && <div ref={menuRef} className="inspector-context-menu" role="menu" aria-label="加入 Monitor" style={{ left: menu.x, top: menu.y }} onClick={(event) => event.stopPropagation()} onKeyDown={onMenuKeyDown}>
        <div className="inspector-context-heading" title={menu.path}>{menu.dashboardId ? "选择 Panel" : "选择 Dashboard"} · {menu.path}</div>
        {menu.dashboardId ? <>
          <button type="button" role="menuitem" onClick={() => setMenu({ ...menu, dashboardId: null })}>← 返回 Dashboard</button>
          {(monitorPanels.find((dashboard) => dashboard.id === menu.dashboardId)?.panels ?? []).map((panel) => <button key={panel.id} type="button" role="menuitem" onClick={() => { onAddToDataGraph?.(menu.path, menu.dashboardId!, panel.id); setMenu(null); }}><span title={panel.title}>{panel.title}</span></button>)}
          <button type="button" role="menuitem" className="inspector-context-new" onClick={() => { onAddToDataGraph?.(menu.path, menu.dashboardId!, null); setMenu(null); }}>＋ 新建 Panel</button>
        </> : <>
          {monitorPanels.map((dashboard) => {
            const ordinal = (panelOrdinal.get(dashboard.name) ?? 0) + 1;
            panelOrdinal.set(dashboard.name, ordinal);
            const label = (panelNameCounts.get(dashboard.name) ?? 0) > 1 ? `${dashboard.name} (${ordinal})` : dashboard.name;
            return <button key={dashboard.id} type="button" role="menuitem" aria-haspopup="menu" data-dashboard-id={dashboard.id} title={label} onClick={() => setMenu({ ...menu, dashboardId: dashboard.id })}>
              <span>{label}</span>{dashboard.id === selectedMonitorPanelId ? <span className="inspector-context-current">当前 ›</span> : <span>›</span>}
            </button>;
          })}
          {monitorPanels.length === 0 && <div className="inspector-context-empty">暂无仪表盘</div>}
        </>}
      </div>}
    </div>
  );
}
