import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { ArrowHelper, AxesHelper, Box3, BufferGeometry, Color, Euler, Group, Line, LineBasicMaterial, Matrix4, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Quaternion, SphereGeometry, Vector3, type Material } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { URDFRobot } from 'urdf-loader';
import { disposeUrdfObject } from './urdfAssetLogic';
import { inertiaEllipsoid, inspectorSubtree, origin, type InspectorModel, type InspectorNode } from './urdfInspectorLogic';

export type InspectorDisplay = 'overlay' | 'visual' | 'collision' | 'frames';
type UrdfObject = Object3D & { isURDFCollider?: boolean; isURDFVisual?: boolean; ignoreLimits?: boolean };
export function mapInspectorObjects(robot: URDFRobot, model: InspectorModel): Map<string, Object3D> {
  const map = new Map<string, Object3D>();
  for (const n of model.nodes) {
    if (n.kind === 'link') { const link = robot.links[n.name]; if (link) map.set(n.id, link); }
    if (n.kind === 'joint') { const joint = robot.joints[n.name]; if (joint instanceof Object3D) map.set(n.id, joint); }
    if (n.kind === 'visual' || n.kind === 'collision') {
      const owner = model.nodes.find(x => x.id === n.owner), link = owner && robot.links[owner.name];
      const index = Number(n.id.match(/\[(\d+)\]$/)?.[1]);
      const obj = link?.children.filter(c => n.kind === 'visual' ? (c as UrdfObject).isURDFVisual : (c as UrdfObject).isURDFCollider)[index];
      if (obj) map.set(n.id, obj);
    }
  }
  return map;
}
function place(object: Object3D, element: Element) {
  const o = origin(element); object.position.fromArray(o.xyz); object.quaternion.setFromEuler(new Euler(o.rpy[0], o.rpy[1], o.rpy[2], 'ZYX')); return object;
}
function Control({ robot, target, revision }: { robot: URDFRobot; target?: Object3D; revision: number }) {
  const { camera, gl, invalidate } = useThree();
  const controlsRef = useRef<OrbitControls | null>(null);
  useEffect(() => { const controls = new OrbitControls(camera, gl.domElement); controlsRef.current = controls; const change = () => invalidate(); controls.addEventListener('change', change); return () => { controls.removeEventListener('change', change); controls.dispose(); controlsRef.current = null; }; }, [camera, gl, invalidate]);
  useEffect(() => {
    const controls = controlsRef.current; if (!controls) return;
    robot.updateWorldMatrix(true, true);
    let box = new Box3().setFromObject(target ?? robot);
    if (box.isEmpty()) box = new Box3().setFromCenterAndSize((target ?? robot).getWorldPosition(new Vector3()), new Vector3(.2,.2,.2));
    const size = Math.max(.15, box.getSize(new Vector3()).length()), center = box.getCenter(new Vector3());
    camera.position.copy(center).add(new Vector3(1, .7, 1).normalize().multiplyScalar(size * 1.6));
    controls.target.copy(center); camera.lookAt(center);
    if (camera instanceof PerspectiveCamera) { camera.near = Math.max(.0001, size / 1000); camera.far = Math.max(100, size * 100); camera.updateProjectionMatrix(); }
    controls.update(); invalidate();
  // Reframe only on request; picking must not disturb the user's camera.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robot, revision, gl, camera, invalidate]);
  return null;
}

function Scene({ robot, model, selected, display, isolate, pose, axes, inertia, focus, onSelect, onTransform }: Props & { robot: URDFRobot }) {
  const { invalidate } = useThree();
  const objects = useMemo(() => mapInspectorObjects(robot, model), [robot, model]);
  const root = useRef<Group>(null);
  const selectedNode = model.nodes.find(n => n.id === selected);
  const target = objects.get(selected) ?? objects.get(selectedNode?.owner ?? '');
  useLayoutEffect(() => {
    for (const j of model.joints) {
      const obj = robot.joints[j.name] as typeof robot.joints[string] & { ignoreLimits: boolean } | undefined;
      if (obj) { obj.ignoreLimits = true; obj.setJointValue(pose[j.name] ?? 0); }
    }
    robot.updateWorldMatrix(true, true); invalidate();
  }, [pose, robot, model, invalidate]);
  useLayoutEffect(() => {
    const originals = new Map<Mesh, Material | Material[]>(), visibility = new Map<Object3D, boolean>(), temporary: Material[] = [];
    const branch = inspectorSubtree(model, selected);
    const owner = selectedNode?.kind === 'link' ? selectedNode.id : selectedNode?.owner;
    const joint = model.joints.find(j => j.id === selected);
    for (const n of model.nodes.filter(n => n.kind === 'visual' || n.kind === 'collision')) {
      const obj = objects.get(n.id); if (!obj) continue;
      const ownerNode = model.nodes.find(x => x.id === n.owner);
      const highlight = n.id === selected || n.owner === selected || Boolean(joint && [joint.parent, joint.child].includes(ownerNode?.name ?? ''));
      const allowed = isolate === 'all' || (isolate === 'subtree' ? branch.has(n.id) : n.id === selected || (selectedNode?.kind === 'link' || selectedNode?.kind === 'joint' ? highlight : n.owner === owner && selectedNode?.kind === 'inertial'));
      visibility.set(obj, obj.visible); obj.visible = allowed && (display === 'overlay' || display === n.kind || display === 'frames' && n.kind === 'visual');
      obj.traverse(o => {
        if (!(o instanceof Mesh)) return;
        originals.set(o, o.material);
        const convert = (m: Material) => {
          const copy = m.clone() as MeshStandardMaterial;
          if (n.kind === 'collision' && copy.color) copy.color.set(highlight ? '#ffba66' : '#36dac7');
          if (highlight && copy.emissive) { copy.emissive = new Color('#af650f'); copy.emissiveIntensity = .45; }
          copy.opacity = n.kind === 'collision' ? .4 : display === 'overlay' ? .24 : display === 'frames' ? .12 : m.opacity;
          copy.transparent = copy.opacity < 1; copy.depthWrite = !copy.transparent; temporary.push(copy); return copy;
        };
        o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
      });
    }
    invalidate();
    return () => { originals.forEach((m, o) => { o.material = m; }); visibility.forEach((v,o) => { o.visible = v; }); temporary.forEach(m => m.dispose()); };
  }, [robot, model, objects, selected, selectedNode, display, isolate, invalidate]);
  useLayoutEffect(() => {
    const helpers: Object3D[] = [];
    const attach = (parent: Object3D, helper: Object3D) => { parent.add(helper); helpers.push(helper); return helper; };
    const size = Math.max(.03, Math.min(.15, new Box3().setFromObject(robot).getSize(new Vector3()).length() / 12));
    for (const n of model.nodes) {
      if (n.kind === 'link' && (display === 'frames' || axes && (selected === n.id || selectedNode?.owner === n.id))) { const obj = objects.get(n.id); if (obj) attach(obj, new AxesHelper(size)); }
      if (n.kind === 'inertial' && inertia && (selected === n.id || selected === n.owner)) {
        const parent = objects.get(n.owner!); if (!parent) continue;
        const group = place(new Group(), n.element); attach(parent, group);
        group.add(new AxesHelper(size));
        group.add(new Mesh(new SphereGeometry(size*.065, 12, 8), new MeshStandardMaterial({ color: '#ffdb70', depthTest: false })));
        const ellipsoid = inertiaEllipsoid(n.element);
        if (ellipsoid) {
          const mesh = new Mesh(new SphereGeometry(1, 24, 16), new MeshStandardMaterial({ color: '#d4a6ff', wireframe: true, transparent: true, opacity: .5 }));
          const matrix = new Matrix4().makeBasis(...ellipsoid.axes.map(v => new Vector3().fromArray(v)) as [Vector3, Vector3, Vector3]);
          mesh.quaternion.setFromRotationMatrix(matrix); mesh.scale.fromArray(ellipsoid.radii); group.add(mesh);
        }
      }
    }
    const joint = model.joints.find(j => j.id === selected);
    if (joint && selectedNode) {
      const parentNode = model.nodes.find(n => n.kind === 'link' && n.name === joint.parent), parent = parentNode && objects.get(parentNode.id);
      if (parent) {
        const frame = place(new Group(), selectedNode.element); attach(parent, frame); frame.add(new AxesHelper(size));
        if (joint.type !== 'fixed') {
          const axis = new Vector3().fromArray(joint.axis).normalize(); frame.add(new ArrowHelper(axis, new Vector3(), size*2, '#ffce70'));
          if (joint.type === 'revolute' || joint.type === 'continuous') {
            const low = joint.type === 'continuous' ? -Math.PI : joint.lower ?? 0, high = joint.type === 'continuous' ? Math.PI : joint.upper ?? 0;
            const rotation = new Quaternion().setFromUnitVectors(new Vector3(0,0,1), axis);
            const points = Array.from({ length: 97 }, (_,i) => { const a = low+(high-low)*i/96; return new Vector3(Math.cos(a)*size, Math.sin(a)*size,0).applyQuaternion(rotation); });
            frame.add(new Line(new BufferGeometry().setFromPoints(points), new LineBasicMaterial({ color: '#ffce70' })));
            const a = pose[joint.name] ?? 0;
            frame.add(new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3(Math.cos(a)*size, Math.sin(a)*size,0).applyQuaternion(rotation)]), new LineBasicMaterial({ color: '#ffffff' })));
          }
          if (joint.type === 'prismatic') frame.add(new Line(new BufferGeometry().setFromPoints([axis.clone().multiplyScalar(joint.lower ?? 0), axis.clone().multiplyScalar(joint.upper ?? 0)]), new LineBasicMaterial({ color: '#ffce70' })));
        }
      }
    }
    robot.updateWorldMatrix(true, true);
    let transformObject = target;
    let transient: Object3D | undefined;
    if (selectedNode?.kind === 'inertial' && target) { transient = place(new Object3D(), selectedNode.element); target.add(transient); transformObject = transient; }
    if (transformObject && root.current) {
      transformObject.updateWorldMatrix(true, false);
      const matrix = root.current.matrixWorld.clone().invert().multiply(transformObject.matrixWorld), p = new Vector3(), q = new Quaternion(), s = new Vector3(); matrix.decompose(p,q,s);
      const e = new Euler().setFromQuaternion(q, 'ZYX');
      onTransform(`${p.toArray().map(v => (v*1000).toFixed(2)).join(' / ')} mm · ${[e.x,e.y,e.z].map(v => (v*180/Math.PI).toFixed(2)).join(' / ')}°`);
    } else onTransform('—');
    transient?.removeFromParent(); invalidate();
    return () => { helpers.forEach(o => { o.removeFromParent(); disposeUrdfObject(o); o.traverse(c => { if (c instanceof Line) { c.geometry.dispose(); (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose()); } }); }); };
  }, [robot, objects, model, selected, selectedNode, axes, inertia, display, pose, target, onTransform, invalidate]);
  function pick(event: ThreeEvent<MouseEvent>) {
    let object: Object3D | null = event.object;
    while (object && object !== robot.parent) {
      const match = [...objects].find(([id, o]) => o === object && (display === 'collision' ? model.nodes.find(n => n.id === id)?.kind === 'collision' : model.nodes.find(n => n.id === id)?.kind === 'link'));
      if (match) { event.stopPropagation(); onSelect(match[0]); return; } object = object.parent;
    }
  }
  return <><ambientLight intensity={1.3}/><directionalLight position={[3,5,4]} intensity={2}/><group ref={root} rotation={[-Math.PI/2,0,0]}><primitive object={robot} onClick={pick}/></group><gridHelper args={[2,20,'#2d5265','#16303e']}/><Control robot={robot} target={focus.selected ? target : undefined} revision={focus.revision}/></>;
}
type Props = { robot: URDFRobot; model: InspectorModel; selected: string; display: InspectorDisplay; isolate: 'all' | 'selected' | 'subtree'; pose: Record<string, number>; axes: boolean; inertia: boolean; focus: { selected: boolean; revision: number }; onSelect(id: string): void; onTransform(value: string): void };
export function UrdfInspectorScene(props: Props) {
  return <Canvas frameloop="demand" camera={{ position: [2,2,2], fov: 45 }} dpr={[1,2]}><color attach="background" args={['#081520']}/><Scene {...props}/></Canvas>;
}
