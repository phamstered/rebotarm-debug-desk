import { useMemo } from "react";
import type { Vec3 } from "./kinematicsLogic";
import { armPosePoints } from "./posePreviewLogic";

export function UrdfPoseThumbnail({
  xml,
  label,
  jointNames,
  positions,
}: {
  xml: string;
  label: string;
  jointNames?: string[];
  positions?: number[];
}) {
  const points = useMemo(() => {
    if (!xml || !jointNames || !positions || positions.length === 0) return null;
    try {
      return armPosePoints(xml, jointNames, positions);
    } catch {
      return null;
    }
  }, [xml, jointNames, positions]);

  if (!points) {
    return <div className="position-thumb position-thumb-empty" aria-label={`${label} 姿态未同步`}>无姿态</div>;
  }
  return (
    <div className="position-thumb" aria-label={`${label} 姿态`} data-tip={points[points.length - 1].map((value) => value.toFixed(3)).join(",")}>
      <PoseSvg points={points} />
    </div>
  );
}

function PoseSvg({ points }: { points: Vec3[] }) {
  const projected = points.map((point) => [point[0], point[2] - point[1] * 0.35] as const);
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = 68 / Math.max(maxX - minX, maxY - minY, 0.05);
  const place = (point: readonly [number, number]) => [
    18 + (point[0] - minX) * scale,
    78 - (point[1] - minY) * scale,
  ] as const;
  const placed = projected.map(place);
  const tip = placed[placed.length - 1];
  return (
    <svg viewBox="0 0 112 84" aria-hidden="true">
      <polyline points={placed.map((point) => point.join(",")).join(" ")} />
      {placed.map((point, index) => <circle key={index} cx={point[0]} cy={point[1]} r={index === placed.length - 1 ? 3.2 : 2} />)}
      <circle className="position-thumb-tip" cx={tip[0]} cy={tip[1]} r="3.2" />
    </svg>
  );
}
