import { UrdfPanelDivider } from "./UrdfPanelDivider";
import { Component, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { URDFRobot } from 'urdf-loader';
import type { BridgeClient } from './bridge';
import { disposeUrdfObject, hydrateUrdfResources, loadUrdfScene } from './urdfAssetLogic';
import { displayNumbers, loadInspectorLayout, inspectorPose, inspectorSubtree, parseInspector, type InspectorNode } from './urdfInspectorLogic';
import { UrdfInspectorScene, type InspectorDisplay } from './UrdfInspectorScene';
import './urdfInspector.css';

class SceneBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <p role="alert">3D 渲染不可用：{this.state.error}。仍可查看参数与 XML。</p> : this.props.children; }
}
function JointValueInput({ value, lower, upper, disabled, onCommit }: { value: number; lower: number; upper: number; disabled: boolean; onCommit(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const parsed = draft.trim() ? Number(draft) : NaN;
    const next = Number.isFinite(parsed) ? Math.max(lower, Math.min(upper, parsed)) : value;
    setDraft(String(next)); onCommit(next);
  };
  return <input aria-label="关节预览数值" title="Enter 或离开输入框应用" type="number" min={lower} max={upper} step="any" value={draft} disabled={disabled}
    onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setDraft(String(value)); }}/>;
}
const EMPTY_POSE: Record<string, number> = {};
type Props = { active: boolean; xml: string; bridge: Pick<BridgeClient, 'getResource'>; jointState: { name?: string[]; position?: number[] } | null; receivedAt?: number; topic: string; liveUpdates: boolean };
export function UrdfInspectorPage(props: Props) {
  // A new description is a new model: clear selection, manual pose and stale async scene work.
  return <Inspector key={props.xml} {...props}/>;
}
function Inspector({ active, xml, bridge, jointState, receivedAt, topic, liveUpdates }: Props) {
  const model = useMemo(() => parseInspector(xml), [xml]);
  const [selected, setSelected] = useState(model.roots[0] ?? model.nodes[0]?.id ?? '');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [display, setDisplay] = useState<InspectorDisplay>('overlay'), [mode, setMode] = useState('zero');
  const [manual, setManual] = useState<Record<string, number>>({});
  const [isolate, setIsolate] = useState<'all' | 'selected' | 'subtree'>('all');
  const [axes, setAxes] = useState(true), [inertia, setInertia] = useState(true);
  const [focus, setFocus] = useState({ selected: false, revision: 0 });
  const [robot, setRobot] = useState<URDFRobot | null>(null), [loadError, setLoadError] = useState(''), [loading, setLoading] = useState(false), [retry, setRetry] = useState(0);
  const [details, setDetails] = useState('parameters'), [world, setWorld] = useState('—');
  const [layout] = useState(loadInspectorLayout);
  const [treeOpen, setTreeOpen] = useState(layout.treeOpen), [propertiesOpen, setPropertiesOpen] = useState(layout.propertiesOpen);
  const [treeWidth, setTreeWidth] = useState(layout.treeWidth), [propertiesWidth, setPropertiesWidth] = useState(layout.propertiesWidth);
  useEffect(() => { try { localStorage.setItem('robot-console-urdf-layout', JSON.stringify({ treeOpen, propertiesOpen, treeWidth, propertiesWidth })); } catch { /* Preferences must not block inspection. */ } }, [treeOpen, propertiesOpen, treeWidth, propertiesWidth]);
  const [now, setNow] = useState(performance.now());
  useEffect(() => { if (!active || mode !== 'live') return; setNow(performance.now()); const timer = window.setInterval(() => setNow(performance.now()), 250); return () => clearInterval(timer); }, [active, mode]);
  const age = receivedAt == null ? Infinity : Math.max(0, now - receivedAt);
  const liveValues = useMemo(() => Object.fromEntries((jointState?.name ?? []).flatMap((name, i) => Number.isFinite(jointState?.position?.[i]) ? [[name, jointState!.position![i]]] : [])), [jointState]);
  const missing = model.joints.filter(j => ['revolute','prismatic','continuous'].includes(j.type) && !j.mimic && !Object.hasOwn(liveValues, j.name));
  const fresh = liveUpdates && age <= 500 && missing.length === 0;
  const sourcePose = mode === 'manual' ? manual : mode === 'live' ? liveValues : EMPTY_POSE;
  const pose = useMemo(() => inspectorPose(model, sourcePose, mode === 'manual'), [model, mode, sourcePose]);
  const node = model.nodes.find(n => n.id === selected), joint = model.joints.find(j => j.id === selected);
  const previewable = joint && !joint.mimic && ['revolute','prismatic','continuous'].includes(joint.type) && model.renderable;
  useEffect(() => {
    if (!active || !xml || !model.renderable) return;
    const abort = new AbortController(); let cleanup: (() => void) | undefined;
    setLoading(true); setLoadError(''); setRobot(null);
    void (async () => {
      const assets = await hydrateUrdfResources(xml, bridge, abort.signal);
      try {
        const scene = await loadUrdfScene(assets, abort.signal, true);
        if (abort.signal.aborted) { disposeUrdfObject(scene); assets.dispose(); return; }
        cleanup = () => { disposeUrdfObject(scene); assets.dispose(); };
        setRobot(scene);
      } catch (e) { assets.dispose(); throw e; }
    })().catch(e => { if (!abort.signal.aborted) setLoadError(e instanceof Error ? e.message : String(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); cleanup?.(); setRobot(null); };
  }, [active, xml, model, bridge, retry]);
  function select(id: string) {
    setSelected(id); setPropertiesOpen(true);
    setCollapsed(previous => new Set([...previous].filter(parent => !inspectorSubtree(model, parent).has(id))));
  }
  const matching = (n: InspectorNode) => (filter === 'all' || n.kind === filter) && `${n.name} ${n.kind}`.toLowerCase().includes(query.toLowerCase());
  const visible = new Set(model.nodes.filter(matching).map(n => n.id));
  const rendered = new Set<string>();
  function tree(id: string, depth: number): ReactNode {
    if (rendered.has(id)) return null; rendered.add(id);
    const n = model.nodes.find(n => n.id === id); if (!n) return null;
    if ((query || filter !== 'all') && ![...inspectorSubtree(model, id)].some(x => visible.has(x))) return null;
    const open = !collapsed.has(id) || !!query || filter !== 'all';
    return <div key={id}>
      <div className={`urdf-tree-row ${selected === id ? 'selected' : ''}`} style={{ paddingLeft: 8 + depth*14 }}>
        {n.children.length ? <button aria-label={`${open ? '折叠' : '展开'} ${n.name}`} onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; })}>{open ? '▾' : '▸'}</button> : <span className="urdf-tree-spacer"/>}
        <button aria-label={`${n.kind} ${n.name}`} aria-pressed={selected === id} onClick={() => select(id)} title={`${n.kind} · ${n.name}`}><small>{n.kind}</small><span>{n.name}</span>{model.issues.some(i => i.node === id && i.level !== 'info') && <b aria-label="存在配置问题">!</b>}</button>
      </div>
      {open && n.children.map(c => tree(c, depth+1))}
    </div>;
  }
  const roots = [...model.roots];
  const reachable = new Set(roots.flatMap(id => [...inspectorSubtree(model,id)]));
  model.nodes.filter(n => !reachable.has(n.id) && !n.owner).forEach(n => roots.push(n.id));
  const style = { '--urdf-tree': treeOpen ? `${treeWidth}px` : '0px', '--urdf-properties': propertiesOpen ? `${propertiesWidth}px` : '0px' } as CSSProperties;
  const unit = joint?.type === 'prismatic' ? 'm' : 'rad';
  const lower = joint?.type === 'continuous' ? -Math.PI : joint?.lower ?? 0, upper = joint?.type === 'continuous' ? Math.PI : joint?.upper ?? 0;
  const updateManual = (value: number) => { if (joint && Number.isFinite(value)) setManual(v => ({ ...v, [joint.name]: Math.max(lower, Math.min(upper, value)) })); };
  if (!xml) return <div className="urdf-empty">等待 {topic} 提供机器人模型。连接后可分析 Joint、Link、Collision 与惯性参数。</div>;
  return <section className={`urdf-inspector ${treeOpen ? '' : 'tree-closed'} ${propertiesOpen ? '' : 'properties-closed'}`} style={style} aria-label="URDF 模型分析">
    <header className="urdf-inspector-toolbar">
      <div><strong>{model.name}</strong><small>{topic} · {model.nodes.filter(n => n.kind === 'link').length} Links · {model.joints.length} Joints · 只读分析</small></div>
      <label>姿态 <select aria-label="URDF 姿态" value={mode} onChange={e => { setNow(performance.now()); setMode(e.target.value); }}><option value="zero">零位</option><option value="live">实时姿态</option><option value="manual">手动预览</option></select></label>
      <label>显示 <select aria-label="URDF 显示" value={display} onChange={e => setDisplay(e.target.value as InspectorDisplay)}><option value="overlay">外观＋碰撞体</option><option value="visual">外观</option><option value="collision">碰撞体</option><option value="frames">坐标系</option></select></label>
      <button aria-expanded={treeOpen} onClick={() => setTreeOpen(v => !v)}>结构树</button><button aria-expanded={propertiesOpen} onClick={() => setPropertiesOpen(v => !v)}>参数</button>
    </header>
    <div className="urdf-inspector-body">
      <aside className="urdf-tree" hidden={!treeOpen} aria-label="URDF 结构树">
        <input type="search" aria-label="搜索 URDF 对象" placeholder="搜索名称…" value={query} onChange={e => setQuery(e.target.value)}/>
        <select aria-label="URDF 对象类型" value={filter} onChange={e => setFilter(e.target.value)}>{['all','link','joint','visual','collision','inertial'].map(k => <option key={k} value={k}>{k === 'all' ? '全部对象' : k}</option>)}</select>
        <UrdfPanelDivider side="tree" value={treeWidth} active={active && treeOpen} onChange={setTreeWidth}/>
        <div className="urdf-tree-scroll">{roots.map(id => tree(id,0))}</div>
      </aside>
      <div className="urdf-scene-area">
        <div className="urdf-scene-tools"><button onClick={() => setFocus(v => ({ selected: false, revision: v.revision+1 }))}>全景</button><button disabled={!node} onClick={() => setFocus(v => ({ selected: true, revision: v.revision+1 }))}>聚焦选中</button>
          <select aria-label="隔离显示" value={isolate} onChange={e => setIsolate(e.target.value as typeof isolate)}><option value="all">全部部件</option><option value="selected">仅选中</option><option value="subtree">选中子树</option></select>
          <label><input type="checkbox" checked={axes} onChange={e => setAxes(e.target.checked)}/>坐标轴</label><label><input type="checkbox" checked={inertia} onChange={e => setInertia(e.target.checked)}/>质心 / 惯性</label>
        </div>
        <div className="urdf-viewport">
          {active && robot && !(mode === 'live' && !fresh) && <SceneBoundary key={retry}><UrdfInspectorScene robot={robot} model={model} selected={selected} display={display} isolate={isolate} pose={pose} axes={axes} inertia={inertia} focus={focus} onSelect={select} onTransform={setWorld}/></SceneBoundary>}
          {loading && <p className="urdf-scene-message" role="status">正在加载模型与资源…</p>}
          {loadError && <div className="urdf-scene-message" role="alert">{loadError}{model.nodes.filter(n => ['visual','collision'].includes(n.kind) && Array.from(n.element.querySelectorAll('[filename]')).some(el => loadError.includes(el.getAttribute('filename') || '\0'))).map(n => <button key={n.id} onClick={() => select(n.id)}>定位 {model.nodes.find(owner => owner.id === n.owner)?.name} / {n.name}</button>)}<button onClick={() => setRetry(v => v+1)}>重试资源加载</button></div>}
          {!model.renderable && <p className="urdf-scene-message">模型结构或参数存在错误；修正下方检查项后可显示 3D。</p>}
          {mode === 'live' && !fresh && <p className="urdf-scene-message" role="status">{!liveUpdates ? '实时显示已暂停' : age > 500 ? 'JointState 缺失或超过 500 ms，实时模型已隐藏' : `缺少关节反馈：${missing.map(j => j.name).join(', ')}`}</p>}
        </div>
        <div className="urdf-scene-caption">{mode === 'manual' ? '本地预览 · 不发送运动指令' : mode === 'zero' ? '零位 · 按 URDF 原点装配' : `只读 JointState · ${Number.isFinite(age) ? `${Math.round(age)} ms` : '等待反馈'}`}<span>橙色：选中 · 青色：碰撞体 · XYZ：红绿蓝</span></div>
      </div>
      <aside className="urdf-properties" hidden={!propertiesOpen} aria-label="URDF 参数">
        <header><small>{node?.kind}</small><strong>{node?.name ?? '选择模型对象'}</strong><button onClick={() => setPropertiesOpen(false)} aria-label="关闭 URDF 参数">×</button></header>
        <UrdfPanelDivider side="properties" value={propertiesWidth} active={active && propertiesOpen} onChange={setPropertiesWidth}/>
        <nav aria-label="URDF 属性视图">{[['parameters','参数'],['xml','XML']].map(([id,label]) => <button key={id} aria-pressed={details === id} onClick={() => setDetails(id)}>{label}</button>)}</nav>
        <div className="urdf-properties-scroll">{details === 'xml' ? <pre aria-label="URDF 原始 XML">{node ? new XMLSerializer().serializeToString(node.element) : ''}</pre> : <>
          <p className="urdf-reference">{node?.kind === 'joint' ? `origin 相对 parent Link：${joint?.parent}` : node?.owner ? `origin 相对所属 Link：${model.nodes.find(n => n.id === node.owner)?.name}` : 'Link 坐标由父 Joint 定义；根 Link 为模型基准'}</p>
          <p className="urdf-reference">当前基座坐标 xyz / rpy<br/>{mode === 'live' && !fresh || !robot ? '—' : world}</p>
          {node?.fields.map((f,i) => <div className="urdf-field" key={i}><span>{f.label}<small>{f.source}</small></span><code>{f.value}</code></div>)}
          {joint && <div className="urdf-joint-preview"><strong>关节预览</strong><p>{displayNumbers(String(pose[joint.name] ?? 0), unit)}</p>{joint.mimic && <p>跟随 {joint.mimic.joint}，不能独立调整</p>}
            {previewable && <><input aria-label="关节预览滑块" type="range" min={lower} max={upper} step={(upper-lower)/1000 || .001} value={pose[joint.name] ?? 0} disabled={mode !== 'manual'} onChange={e => updateManual(Number(e.target.value))}/><label>位置 ({unit})<JointValueInput key={joint.id} value={pose[joint.name] ?? 0} lower={lower} upper={upper} disabled={mode !== 'manual'} onCommit={updateManual}/></label><button onClick={() => { setMode('manual'); setManual(pose); }}>启用手动预览</button><button onClick={() => setManual({})}>重置本地姿态</button></>}
          </div>}
          {node?.kind === 'link' && <div className="urdf-related">{model.joints.filter(j => j.parent === node.name).map(j => <button key={j.id} onClick={() => select(j.id)}>子 Joint · {j.name}</button>)}</div>}
        </>}</div>
      </aside>
    </div>
    <details className="urdf-diagnostics"><summary>模型检查 · {model.issues.filter(i => i.level === 'error').length} 错误 · {model.issues.filter(i => i.level === 'warning').length} 警告 · {model.issues.filter(i => i.level === 'info').length} 提示 <span>碰撞体展示不执行碰撞检测</span></summary>
      <div>{model.issues.length ? model.issues.map((issue,i) => <button key={i} className={`urdf-issue ${issue.level}`} onClick={() => { setQuery(''); setFilter('all'); select(issue.node); setTreeOpen(true); }}><b>{issue.level}</b> {model.nodes.find(n => n.id === issue.node)?.name} · {issue.message}</button>) : <p>未发现基础配置问题；此结果不替代物理验证或规划碰撞检查。</p>}</div>
    </details>
  </section>;
}
