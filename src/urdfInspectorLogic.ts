/** Read-only URDF inspection. Keep source values separate from defaults and scene objects. */
export type InspectorKind = 'link' | 'joint' | 'visual' | 'collision' | 'inertial';
export type InspectorField = { label: string; value: string; source: '配置' | '默认' | '未配置' };
export type InspectorNode = { id: string; kind: InspectorKind; name: string; owner?: string; element: Element; fields: InspectorField[]; children: string[] };
export type InspectorJoint = { id: string; name: string; type: string; parent: string; child: string; axis: number[]; lower?: number; upper?: number; mimic?: { joint: string; multiplier: number; offset: number } };
export type InspectorIssue = { node: string; level: 'error' | 'warning' | 'info'; message: string };
export type InspectorModel = { name: string; nodes: InspectorNode[]; roots: string[]; joints: InspectorJoint[]; issues: InspectorIssue[]; renderable: boolean };
export const child = (el: Element, tag: string) => Array.from(el.children).find(e => e.tagName === tag);
export function numbers(raw: string | null | undefined, fallback: number[] = []): number[] {
  return raw == null ? fallback : raw.trim() ? raw.trim().split(/\s+/).map(Number) : [NaN];
}
export function origin(el: Element) {
  const o = child(el, 'origin');
  return { xyz: numbers(o?.getAttribute('xyz'), [0, 0, 0]), rpy: numbers(o?.getAttribute('rpy'), [0, 0, 0]) };
}
const fmt = (n: number) => Number(n.toFixed(5)).toString();
export function displayNumbers(raw: string, unit: string) {
  const ns = numbers(raw);
  if (!ns.every(Number.isFinite)) return raw;
  return `${raw}${unit ? ` ${unit}` : ''}${unit === 'm' ? ` · ${ns.map(n => fmt(n * 1000)).join(' ')} mm` : unit === 'rad' ? ` · ${ns.map(n => fmt(n * 180 / Math.PI)).join(' ')}°` : ''}`;
}

/** Symmetric Jacobi eigendecomposition; columns are principal axes in the inertia frame. */
export function inertiaEllipsoid(el: Element): { radii: number[]; axes: number[][] } | null {
  const mass = Number(child(el, 'mass')?.getAttribute('value'));
  const tensor = child(el, 'inertia');
  if (!tensor || !Number.isFinite(mass) || mass <= 0) return null;
  const values = ['ixx', 'ixy', 'ixz', 'iyy', 'iyz', 'izz'].map(k => tensor.hasAttribute(k) ? Number(tensor.getAttribute(k)) : NaN);
  if (!values.every(Number.isFinite)) return null;
  const [xx, xy, xz, yy, yz, zz] = values;
  const a = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let step = 0; step < 40; step++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-14) break;
    const angle = .5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(angle), s = Math.sin(angle);
    const ap = a[p][p], aq = a[q][q], off = a[p][q];
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) { const x = a[k][p], y = a[k][q]; a[k][p] = a[p][k] = c*x-s*y; a[k][q] = a[q][k] = s*x+c*y; }
      const x = v[k][p], y = v[k][q]; v[k][p] = c*x-s*y; v[k][q] = s*x+c*y;
    }
    a[p][p] = c*c*ap-2*s*c*off+s*s*aq; a[q][q] = s*s*ap+2*s*c*off+c*c*aq; a[p][q] = a[q][p] = 0;
  }
  const moments = [a[0][0], a[1][1], a[2][2]];
  const squared = moments.map((i, index) => 5 * (moments[(index+1)%3]+moments[(index+2)%3]-i) / (2*mass));
  if (moments.some(i => i <= 0) || squared.some(x => x <= 0 || !Number.isFinite(x))) return null;
  return { radii: squared.map(Math.sqrt), axes: [0, 1, 2].map(i => v.map(row => row[i])) };
}

export function parseInspector(xml: string): InspectorModel {
  const model: InspectorModel = { name: '', nodes: [], roots: [], joints: [], issues: [], renderable: false };
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const robot = doc.documentElement;
  const issue = (node: string, level: InspectorIssue['level'], message: string) => model.issues.push({ node, level, message });
  if (robot.tagName !== 'robot' || doc.querySelector('parsererror')) { issue('', 'error', '无法解析 URDF：需要有效的 robot XML'); return model; }
  model.name = robot.getAttribute('name') || '未命名机器人';
  const add = (element: Element, kind: InspectorKind, id: string, owner?: string) => {
    const node: InspectorNode = { id, kind, name: element.getAttribute('name') || id.split('/').pop()!, owner, element, fields: [], children: [] };
    const field = (label: string, el: Element | undefined, attr: string, unit = '', fallback?: string, count?: number) => {
      const raw = el?.getAttribute(attr), value = raw ?? fallback;
      node.fields.push({ label, value: value == null ? '—' : unit || count ? displayNumbers(value, unit) : value, source: raw != null ? '配置' : fallback != null ? '默认' : '未配置' });
      if (raw != null && (unit || count)) { const ns = numbers(raw); if (ns.some(n => !Number.isFinite(n)) || (count && ns.length !== count)) issue(id, 'error', `${label} 数值或维度无效`); }
    };
    field('name', element, 'name');
    if (kind !== 'link') { field('origin.xyz', child(element, 'origin'), 'xyz', 'm', '0 0 0', 3); field('origin.rpy', child(element, 'origin'), 'rpy', 'rad', '0 0 0', 3); }
    if (kind === 'joint') {
      field('type', element, 'type'); field('parent', child(element, 'parent'), 'link'); field('child', child(element, 'child'), 'link');
      const type = element.getAttribute('type') || '', limit = child(element, 'limit'), mimic = child(element, 'mimic');
      if (!['fixed', 'floating'].includes(type)) field('axis.xyz', child(element, 'axis'), 'xyz', '', '1 0 0', 3);
      if (['revolute', 'prismatic', 'continuous'].includes(type)) {
        for (const key of ['lower', 'upper', 'velocity', 'effort']) field(`limit.${key}`, limit, key, key === 'effort' ? type === 'prismatic' ? 'N' : 'N·m' : key === 'velocity' ? type === 'prismatic' ? 'm/s' : 'rad/s' : type === 'prismatic' ? 'm' : 'rad');
      }
      for (const key of ['damping', 'friction']) field(`dynamics.${key}`, child(element, 'dynamics'), key, '', '0', 1);
      if (mimic) { field('mimic.joint', mimic, 'joint'); field('mimic.multiplier', mimic, 'multiplier', '', '1', 1); field('mimic.offset', mimic, 'offset', type === 'prismatic' ? 'm' : 'rad', '0'); }
      const joint: InspectorJoint = { id, name: node.name, type, parent: child(element, 'parent')?.getAttribute('link') || '', child: child(element, 'child')?.getAttribute('link') || '', axis: numbers(child(element, 'axis')?.getAttribute('xyz'), [1,0,0]), lower: limit?.hasAttribute('lower') ? Number(limit.getAttribute('lower')) : undefined, upper: limit?.hasAttribute('upper') ? Number(limit.getAttribute('upper')) : undefined,
        mimic: mimic ? { joint: mimic.getAttribute('joint') || '', multiplier: Number(mimic.getAttribute('multiplier') ?? 1), offset: Number(mimic.getAttribute('offset') ?? 0) } : undefined };
      model.joints.push(joint);
      if (!['fixed', 'revolute', 'continuous', 'prismatic', 'floating', 'planar'].includes(type)) issue(id, 'error', '未知 joint 类型');
      if (['floating', 'planar'].includes(type)) issue(id, 'warning', '此类型暂不支持姿态预览，仅显示零位及配置');
      if (!['fixed', 'floating'].includes(type) && Math.hypot(...joint.axis) === 0) issue(id, 'error', '关节轴不能为零向量');
      if (['revolute', 'prismatic'].includes(type) && (joint.lower == null || joint.upper == null || joint.lower > joint.upper)) issue(id, 'error', '关节限位缺失或上下限颠倒');
      for (const key of ['velocity', 'effort']) if (limit?.hasAttribute(key) && Number(limit.getAttribute(key)) < 0) issue(id, 'error', `${key} 不能为负数`);
      if (joint.lower != null && joint.upper != null && (joint.lower > 0 || joint.upper < 0)) issue(id, 'warning', '零位位于声明限位之外');
    }
    if (kind === 'visual' || kind === 'collision') {
      const geometry = child(element, 'geometry'), shape = geometry?.firstElementChild;
      node.fields.push({ label: 'geometry', value: shape?.tagName || '—', source: shape ? '配置' : '未配置' });
      if (!shape || !['box', 'sphere', 'cylinder', 'mesh'].includes(shape.tagName) || geometry?.children.length !== 1) issue(id, 'error', '缺失或不支持的几何类型');
      if (shape) {
        const fields = shape.tagName === 'mesh' ? ['filename', 'scale'] : shape.tagName === 'box' ? ['size'] : shape.tagName === 'sphere' ? ['radius'] : ['radius', 'length'];
        for (const key of fields) {
          field(key, shape, key, key === 'filename' || key === 'scale' ? '' : 'm', key === 'scale' ? '1 1 1' : undefined, key === 'scale' || key === 'size' ? 3 : key === 'filename' ? undefined : 1);
          if (key !== 'filename' && numbers(shape.getAttribute(key), key === 'scale' ? [1,1,1] : [NaN]).some(n => !Number.isFinite(n) || (key === 'scale' ? n === 0 : n <= 0))) issue(id, 'error', `${key} 必须为${key === 'scale' ? '非零有限值' : '正数'}`);
          if (key === 'scale' && numbers(shape.getAttribute(key)).some(n => n < 0)) issue(id, 'warning', 'Mesh 使用负 scale（镜像缩放），请核对方向和法线');
        }
        if (shape.tagName === 'mesh' && !shape.getAttribute('filename')) issue(id, 'error', '缺失 mesh URI');
      }
      if (kind === 'visual') {
        const material = child(element, 'material');
        const resolved = material && !child(material, 'color') && !child(material, 'texture') ? Array.from(robot.children).find(e => e.tagName === 'material' && e.getAttribute('name') === material.getAttribute('name')) ?? material : material;
        field('material', material, 'name'); field('rgba', resolved && child(resolved, 'color'), 'rgba', '', undefined, 4); field('texture', resolved && child(resolved, 'texture'), 'filename');
      }
    }
    if (kind === 'inertial') {
      field('mass', child(element, 'mass'), 'value', 'kg');
      for (const key of ['ixx', 'ixy', 'ixz', 'iyy', 'iyz', 'izz']) field(key, child(element, 'inertia'), key, 'kg·m²');
      if (!inertiaEllipsoid(element)) issue(id, 'warning', '质量或惯性矩阵无效/退化，无法生成等效惯性椭球');
    }
    model.nodes.push(node); return node;
  };
  const links = new Map<string, InspectorNode>(), names = new Set<string>();
  for (const [i, el] of Array.from(robot.children).filter(e => e.tagName === 'link').entries()) {
    const link = add(el, 'link', `link:${i}`);
    const name = el.getAttribute('name');
    if (!name || links.has(name)) issue(link.id, 'error', 'Link 名称缺失或重复'); else links.set(name, link);
    const counts: Record<string, number> = {};
    for (const el of Array.from(link.element.children)) if (['visual', 'collision', 'inertial'].includes(el.tagName)) {
      const index = counts[el.tagName] ?? 0; counts[el.tagName] = index + 1;
      const n = add(el, el.tagName as InspectorKind, `${link.id}/${el.tagName}[${index}]`, link.id); link.children.push(n.id);
    }
    for (const kind of ['collision', 'inertial']) if (!counts[kind]) issue(link.id, 'info', `未配置 ${kind}，请结合用途确认`);
    link.fields.push({ label: 'Visual / Collision', value: `${counts.visual ?? 0} / ${counts.collision ?? 0}`, source: '配置' });
  }
  const children = new Set<string>();
  for (const [i, el] of Array.from(robot.children).filter(e => e.tagName === 'joint').entries()) {
    const n = add(el, 'joint', `joint:${i}`), j = model.joints.at(-1)!;
    if (!el.getAttribute('name') || names.has(j.name)) issue(n.id, 'error', 'Joint 名称缺失或重复'); names.add(j.name);
    const parent = links.get(j.parent), target = links.get(j.child);
    if (!parent || !target) issue(n.id, 'error', 'parent / child 引用了不存在的 Link');
    if (children.has(j.child)) issue(n.id, 'error', '同一 Link 存在多个父 Joint');
    children.add(j.child); parent?.children.push(n.id); if (target) { n.children.push(target.id); target.fields.push({ label: '父 Joint / Link', value: `${j.name} / ${j.parent}`, source: '配置' }); }
  }
  const walkCycle = (name: string, path: Set<string>, adjacency: (name: string) => string[], node: string) => {
    if (path.has(name)) { issue(node, 'error', '模型或 mimic 存在循环引用'); return; }
    if (path.size > model.nodes.length) return;
    const next = new Set(path).add(name); adjacency(name).forEach(n => walkCycle(n, next, adjacency, node));
  };
  for (const j of model.joints) {
    walkCycle(j.parent, new Set(), name => model.joints.filter(x => x.parent === name).map(x => x.child), j.id);
    if (j.mimic) {
      if (!names.has(j.mimic.joint)) issue(j.id, 'error', 'mimic 引用了不存在的 Joint');
      walkCycle(j.name, new Set(), name => { const m = model.joints.find(x => x.name === name)?.mimic; return m ? [m.joint] : []; }, j.id);
    }
  }
  model.roots = [...links.values()].filter(n => !children.has(n.name)).map(n => n.id);
  if (model.roots.length !== 1) issue(model.roots[0] || model.nodes[0]?.id || '', 'error', '模型需要唯一根 Link；存在多根、断链或循环');
  model.renderable = !model.issues.some(i => i.level === 'error');
  return model;
}

export function inspectorPose(model: InspectorModel, values: Record<string, number>, clamp: boolean): Record<string, number> {
  const result: Record<string, number> = Object.create(null);
  const resolve = (j: InspectorJoint, visiting = new Set<string>()): number => {
    if (j.name in result) return result[j.name];
    if (visiting.has(j.name)) return 0;
    visiting.add(j.name);
    let value = Number.isFinite(values[j.name]) ? values[j.name] : 0;
    if (j.mimic) { const target = model.joints.find(x => x.name === j.mimic!.joint); value = (target ? resolve(target, visiting) : 0) * j.mimic.multiplier + j.mimic.offset; }
    else if (clamp && ['revolute', 'prismatic'].includes(j.type)) value = Math.max(j.lower ?? -Infinity, Math.min(j.upper ?? Infinity, value));
    return result[j.name] = j.type === 'fixed' ? 0 : Number.isFinite(value) ? value : 0;
  };
  model.joints.forEach(j => resolve(j)); return result;
}

export function inspectorSubtree(model: InspectorModel, id: string): Set<string> {
  const ids = new Set<string>();
  const visit = (key: string) => { if (ids.has(key)) return; ids.add(key); model.nodes.find(n => n.id === key)?.children.forEach(visit); };
  visit(id); return ids;
}

export function loadInspectorLayout() {
  const defaults = { treeWidth: 230, propertiesWidth: 320, treeOpen: true, propertiesOpen: true };
  try {
    const stored = JSON.parse(localStorage.getItem('robot-console-urdf-layout') || '{}');
    for (const [key, low, high] of [['treeWidth',170,360],['propertiesWidth',260,460]] as const) {
      if (typeof stored[key] === 'number' && Number.isFinite(stored[key])) defaults[key] = Math.max(low,Math.min(high,stored[key]));
    }
    for (const key of ['treeOpen','propertiesOpen'] as const) if (typeof stored[key] === 'boolean') defaults[key] = stored[key];
  } catch { /* Unavailable or malformed preferences keep safe defaults. */ }
  return defaults;
}
