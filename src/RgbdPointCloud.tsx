import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry, Points, PointsMaterial, Color } from "three";
import type { ColoredPointCloud } from "./rgbdPointCloudLogic";
import { cloudPositionsToScene } from "./rgbdPointCloudLogic";

export type RgbdColorMode = "rgb" | "depth";

export type RgbdPointCloudProps = {
  cloud: ColoredPointCloud | null;
  visible: boolean;
  pointSize: number;
  colorMode: RgbdColorMode;
  nearM: number;
  farM: number;
};

function depthToColor(depth: number, nearM: number, farM: number, out: Color): void {
  const span = Math.max(1e-6, farM - nearM);
  const t = Math.min(1, Math.max(0, (depth - nearM) / span));
  // cyan → magenta heatmap
  out.setRGB(t, 1 - Math.abs(t - 0.5) * 2, 1 - t);
}

/**
 * Three.js point cloud layer for Robot View. Updates BufferAttributes in place;
 * does not create React elements per point or drive page-level state.
 */
export function RgbdPointCloudLayer({
  cloud,
  visible,
  pointSize,
  colorMode,
  nearM,
  farM,
}: RgbdPointCloudProps) {
  const pointsRef = useRef<Points | null>(null);
  const geometry = useMemo(() => new BufferGeometry(), []);
  const material = useMemo(
    () => new PointsMaterial({ size: pointSize, vertexColors: true, sizeAttenuation: true }),
    // pointSize applied imperatively below so material identity stays stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);

  useEffect(() => {
    material.size = pointSize;
  }, [material, pointSize]);

  useEffect(() => {
    if (!cloud || cloud.count === 0) {
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
      geometry.setAttribute("color", new BufferAttribute(new Float32Array(0), 3));
      geometry.setDrawRange(0, 0);
      geometry.computeBoundingSphere();
      return;
    }
    const positions = cloudPositionsToScene(cloud.positions);
    const colors = new Float32Array(cloud.count * 3);
    if (colorMode === "depth") {
      const tmp = new Color();
      for (let i = 0; i < cloud.count; i += 1) {
        depthToColor(cloud.depths[i], nearM, farM, tmp);
        colors[i * 3] = tmp.r;
        colors[i * 3 + 1] = tmp.g;
        colors[i * 3 + 2] = tmp.b;
      }
    } else {
      colors.set(cloud.colors);
    }
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.setDrawRange(0, cloud.count);
    geometry.computeBoundingSphere();
  }, [cloud, colorMode, geometry, nearM, farM]);

  return (
    <points ref={pointsRef} geometry={geometry} material={material} visible={visible && Boolean(cloud?.count)} />
  );
}
