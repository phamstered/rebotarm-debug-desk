import {
  applyPoint,
  chainToLink,
  identity4,
  jointMotionMatrix,
  jointOriginMatrix,
  mul4,
  parseKinematics,
  resolveTcpLink,
  type Vec3,
} from "./kinematicsLogic";

export function armPosePoints(xml: string, names: string[], values: number[], tipLink?: string): Vec3[] {
  const model = parseKinematics(xml);
  const tip = tipLink && model.links.includes(tipLink) ? tipLink : resolveTcpLink(model);
  const chain = chainToLink(model, tip);
  const byName = new Map(names.map((name, index) => [name, values[index]]));
  const points: Vec3[] = [[0, 0, 0]];
  let matrix = identity4();
  for (const joint of chain) {
    matrix = mul4(matrix, jointOriginMatrix(joint));
    if (joint.type !== "fixed") {
      const value = byName.get(joint.name);
      matrix = mul4(matrix, jointMotionMatrix(joint, Number.isFinite(value) ? value! : 0));
    }
    const point = applyPoint(matrix, [0, 0, 0]);
    const previous = points[points.length - 1];
    const distance = Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
    if (distance > 1e-4) points.push(point);
  }
  return points;
}
