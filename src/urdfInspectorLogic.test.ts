import { describe, expect, it } from 'vitest';
import { displayNumbers, loadInspectorLayout, inertiaEllipsoid, inspectorPose, inspectorSubtree, parseInspector } from './urdfInspectorLogic';
import URDFLoader from 'urdf-loader';
import { mapInspectorObjects } from './UrdfInspectorScene';
import { Vector3 } from 'three';
import inspectionFixture from "./testFixtures/urdf-inspector.urdf?raw";
describe('URDF inspection', () => {
 it('retains repeated unnamed collisions, source XML and explicit/default/missing provenance', () => {
  const m = parseInspector(inspectionFixture); expect(m.renderable).toBe(true);
  const collisions = m.nodes.filter(n => n.kind === 'collision'); expect(collisions.map(n => n.id)).toEqual(['link:0/collision[0]','link:1/collision[0]','link:1/collision[1]']);
  const j = m.nodes.find(n => n.name === 'shoulder')!;
  expect(j.fields.find(f => f.label === 'origin.rpy')).toMatchObject({ source: '默认', value: '0 0 0 rad · 0 0 0°' });
  expect(j.fields.find(f => f.label === 'limit.upper')).toMatchObject({ source: '配置' });
  expect(m.nodes.find(n => n.id === 'link:0/visual[0]')!.fields.find(f => f.label === 'rgba')?.value).toBe('0.2 0.5 0.8 1');
  expect(collisions[1].element.outerHTML).toContain('0 0 0.1');
  expect(inspectorSubtree(m, j.id).has('link:1/collision[1]')).toBe(true);
 });
 it('clamps only manual drivers and resolves mimic multipliers/offsets recursively', () => {
  const m = parseInspector(inspectionFixture);
  expect(inspectorPose(m, { shoulder: 9 }, true)).toEqual({ shoulder: 1.5, follower: -2.9 });
  expect(inspectorPose(m, { shoulder: 9 }, false)).toEqual({ shoulder: 9, follower: -17.9 });
  expect(inspectorPose(m, {}, false)).toEqual({ shoulder: 0, follower: .1 });
  expect(inspectorPose(m, { shoulder: NaN }, true).shoulder).toBe(0);
 });
 it.each([
  ['<robot><link name="a"/><link name="a"/></robot>', '重复'],
  ['<robot><link name="a"/><link name="b"/></robot>', '唯一根'],
  [inspectionFixture.replace('link="arm"', 'link="missing"'), '不存在'],
  [inspectionFixture.replace('xyz="0 1 0"','xyz="0 0 0"'), '零向量'],
  [inspectionFixture.replace('upper="1.5"','upper="-2"'), '颠倒'],
  [inspectionFixture.replace('radius="0.05"','radius="-1"'), '正数'],
  [inspectionFixture.replace('xyz="0 1 0"','xyz="NaN 0"'), '维度'],
  [inspectionFixture.replace('joint="shoulder"','joint="follower"'), '循环'],
  [inspectionFixture.replace('joint="shoulder"','joint="missing"'), '不存在'],
  [inspectionFixture.replace('<parent link="base"/>','<parent link="finger"/>'), '循环'],
  ['<robot>', '有效'],
 ])('rejects invalid model without recursive tree crashes', (xml, error) => {
  const m = parseInspector(xml); expect(m.renderable).toBe(false); expect(m.issues.some(i => i.message.includes(error))).toBe(true);
  m.nodes.forEach(n => expect(inspectorSubtree(m,n.id).size).toBeLessThanOrEqual(m.nodes.length));
 });
 it('maps exact collision indices and joint frames to real loader objects', () => {
  const loader = new URDFLoader(); loader.parseCollision = true;
  const robot = loader.parse(inspectionFixture), model = parseInspector(inspectionFixture), objects = mapInspectorObjects(robot,model);
  expect(objects.get('link:1/collision[0]')?.position.z).toBe(.1);
  expect(objects.get('link:1/collision[1]')?.position.z).toBe(.3);
  expect(objects.get('joint:0')).toBe(robot.joints.shoulder);
  robot.setJointValue('shoulder', .3);
  expect(objects.get('link:1/collision[1]')!.getWorldPosition(new Vector3()).x).toBeCloseTo(Math.sin(.3)*.3);
 });
 it('creates a physical inertia ellipsoid and rejects nonphysical or missing tensors', () => {
  const n = parseInspector(inspectionFixture).nodes.find(n => n.kind === 'inertial')!;
  const ellipsoid = inertiaEllipsoid(n.element)!;
  expect(ellipsoid.radii.every(n => n > 0)).toBe(true);
  expect(new Vector3(...ellipsoid.axes[0]).dot(new Vector3(...ellipsoid.axes[1]))).toBeCloseTo(0);
  const sphere = new DOMParser().parseFromString('<inertial><mass value="1"/><inertia ixx="0.4" iyy="0.4" izz="0.4" ixy="0" ixz="0" iyz="0"/></inertial>','application/xml').documentElement;
  expect(inertiaEllipsoid(sphere)!.radii).toEqual([1,1,1]);
  sphere.querySelector('inertia')!.setAttribute('ixx','5'); expect(inertiaEllipsoid(sphere)).toBeNull();
  sphere.querySelector('mass')!.remove(); expect(inertiaEllipsoid(sphere)).toBeNull();
 });
 it('converts display units without changing the source', () => { expect(displayNumbers('0.02','m')).toBe('0.02 m · 20 mm'); expect(displayNumbers(String(Math.PI),'rad')).toContain('180°'); });
});

it('preserves and bounds panel preferences independently of model state', () => {
 localStorage.setItem('robot-console-urdf-layout', JSON.stringify({treeOpen:false,treeWidth:999,propertiesWidth:10}));
 expect(loadInspectorLayout()).toEqual({treeOpen:false,propertiesOpen:true,treeWidth:360,propertiesWidth:260});
 localStorage.setItem('robot-console-urdf-layout', '{'); expect(loadInspectorLayout().treeWidth).toBe(230);
 localStorage.removeItem('robot-console-urdf-layout');
});
it('allows mirrored mesh scale but reports it for inspection', () => {
 const m = parseInspector('<robot><link name="base"><visual><geometry><mesh filename="package://robot/a.stl" scale="-1 1 1"/></geometry></visual></link></robot>');
 expect(m.renderable).toBe(true); expect(m.issues.some(i => i.message.includes('镜像缩放'))).toBe(true);
});
