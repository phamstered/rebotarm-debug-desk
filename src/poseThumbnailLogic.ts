import * as THREE from "three";
import { SVGRenderer } from "three/addons/renderers/SVGRenderer.js";
import { applyPoint, chainToLink, forwardKinematics, parseKinematics, resolveTcpLink, type Vec3 } from "./kinematicsLogic";
import { armPosePoints } from "./posePreviewLogic";

export type PoseThumbnail = { points: Vec3[]; toolAxes: Vec3[]; fingers: Vec3[][] };

/** Geometry only: no mesh downloads, live feedback or control commands. */
export function poseThumbnail(xml: string, names: string[], values: number[]): PoseThumbnail {
  if (names.length !== values.length || new Set(names).size !== names.length || values.some(value => !Number.isFinite(value))) {
    throw new Error("姿态关节值无效");
  }
  const model = parseKinematics(xml);
  const byName = new Map(names.map((name, index) => [name, values[index]]));
  const frameFor = (link: string) => {
    const chain = chainToLink(model, link);
    const positions = chain.filter(joint => joint.type !== "fixed").map(joint => {
      const value = byName.get(joint.mimic ?? joint.name);
      // Unspecified gripper targets mean hold current; omit the fingers below.
      if (value === undefined) throw new Error(`缺少关节 ${joint.name}`);
      return value;
    });
    return forwardKinematics(chain, positions);
  };
  const tool = frameFor(resolveTcpLink(model));
  const axisLength = 0.045;
  const toolAxes = ([[axisLength, 0, 0], [0, axisLength, 0], [0, 0, axisLength]] as Vec3[])
    .map(axis => applyPoint(tool.matrix, axis));
  const fingers = model.joints.filter(joint => joint.type === "prismatic" && /finger|jaw/i.test(joint.name)
    && byName.has(joint.mimic ?? joint.name)).map(joint => {
      const frame = frameFor(joint.child);
      return [frame.position, applyPoint(frame.matrix, [0, 0, 0.035])];
    });
  const points = armPosePoints(xml, names, values);
  if (points.length < 2 || [...points, ...toolAxes, ...fingers.flat()].some(point => point.some(value => !Number.isFinite(value)))) {
    throw new Error("没有可用的姿态几何");
  }
  return { points, toolAxes, fingers };
}

/** Render a small lit 3D scene once as SVG, avoiding one WebGL context per card. */
export function renderPoseThumbnail(pose: PoseThumbnail): SVGElement {
  const scene = new THREE.Scene();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const meshMaterial = (color: number) => {
    const material = new THREE.MeshLambertMaterial({ color });
    materials.push(material);
    return material;
  };
  const arm = meshMaterial(0x83c5d0);
  const joint = meshMaterial(0xdce9ef);
  const tool = meshMaterial(0x42d6b5);
  const radius = 0.017;
  const sphere = new THREE.SphereGeometry(radius * 1.4, 8, 6);
  geometries.push(sphere);
  const vector = (point: Vec3) => new THREE.Vector3(...point);
  const rod = (a: Vec3, b: Vec3, width: number, material: THREE.Material) => {
    const start = vector(a), end = vector(b);
    const length = start.distanceTo(end);
    if (length < 1e-6) return;
    const geometry = new THREE.CylinderGeometry(width, width, length, 8);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(start.add(end).multiplyScalar(0.5));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector(b).sub(vector(a)).normalize());
    scene.add(mesh);
  };
  pose.points.forEach((point, index) => {
    if (index) rod(pose.points[index - 1], point, radius, index === pose.points.length - 1 ? tool : arm);
    const mesh = new THREE.Mesh(sphere, index === pose.points.length - 1 ? tool : joint);
    mesh.position.copy(vector(point));
    scene.add(mesh);
  });
  pose.fingers.forEach(([a, b]) => rod(a, b, radius * 0.55, tool));
  const line = (a: Vec3, b: Vec3, color: number) => {
    const geometry = new THREE.BufferGeometry().setFromPoints([vector(a), vector(b)]);
    const material = new THREE.LineBasicMaterial({ color });
    geometries.push(geometry); materials.push(material);
    scene.add(new THREE.Line(geometry, material));
  };
  const colors = [0xe77c7c, 0x7ccc9b, 0x78a9ef];
  pose.toolAxes.forEach((axis, index) => line(pose.points[pose.points.length - 1], axis, colors[index]));
  const base = pose.points[0];
  for (let i = -2; i <= 2; i++) {
    const d = i * 0.05;
    line([base[0] - 0.1, base[1] + d, base[2]], [base[0] + 0.1, base[1] + d, base[2]], 0x254250);
    line([base[0] + d, base[1] - 0.1, base[2]], [base[0] + d, base[1] + 0.1, base[2]], 0x254250);
  }
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(1, -2, 3); scene.add(light);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100);
  camera.up.set(0, 0, 1);
  const bounds = new THREE.Box3().setFromObject(scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const extent = bounds.getSize(new THREE.Vector3()).length();
  camera.position.copy(center).add(new THREE.Vector3(1.3, -1.8, 1.1).normalize().multiplyScalar(Math.max(extent * 3, 1)));
  camera.lookAt(center); camera.updateMatrixWorld();
  // Fit all corners in camera space so tall, wide and folded poses stay inside.
  const viewBounds = new THREE.Box3();
  scene.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.computeBoundingBox();
    const transform = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
    viewBounds.union(object.geometry.boundingBox!.clone().applyMatrix4(transform));
  });
  const size = viewBounds.getSize(new THREE.Vector3());
  const halfHeight = Math.max(size.y, size.x / (4 / 3), 0.1) * 0.61;
  camera.left = -halfHeight * 4 / 3; camera.right = halfHeight * 4 / 3;
  camera.top = halfHeight; camera.bottom = -halfHeight; camera.updateProjectionMatrix();
  const renderer = new SVGRenderer();
  renderer.setSize(160, 120); renderer.setPrecision(2);
  try {
    renderer.render(scene, camera);
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.setAttribute("data-renderer", "simplified-3d");
    renderer.domElement.style.backgroundColor = "transparent";
    return renderer.domElement;
  } finally {
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }
}
