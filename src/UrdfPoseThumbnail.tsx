import { useEffect, useMemo, useRef } from "react";
import { poseThumbnail, renderPoseThumbnail } from "./poseThumbnailLogic";

export function UrdfPoseThumbnail({ xml, label, jointNames, positions }: {
  xml: string;
  label: string;
  jointNames?: string[];
  positions?: number[];
}) {
  // App telemetry can recreate equal arrays; retain the static scene until values change.
  const namesKey = jointNames?.join("\0");
  const valuesKey = positions?.join("\0");
  const preview = useMemo(() => {
    if (!xml || !jointNames || !positions || positions.length === 0) return null;
    try {
      const pose = poseThumbnail(xml, jointNames, positions);
      return { pose, svg: renderPoseThumbnail(pose) };
    } catch {
      return null;
    }
  }, [xml, namesKey, valuesKey]);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!preview || !host.current) return;
    const element = host.current;
    element.replaceChildren(preview.svg);
    return () => element.replaceChildren();
  }, [preview]);

  if (!preview) {
    return <div className="position-thumb position-thumb-empty" aria-label={`${label} 姿态未同步`}>无姿态</div>;
  }
  return (
    <div className="position-thumb" role="img" aria-label={`${label} 姿态`}
      title="简化 3D 姿态 · 红 X / 绿 Y / 蓝 Z"
      data-tip={preview.pose.points[preview.pose.points.length - 1].map(value => value.toFixed(3)).join(",")}>
      <div ref={host} className="position-thumb-scene" />
      <span className="position-thumb-badge" aria-hidden="true">3D</span>
    </div>
  );
}
