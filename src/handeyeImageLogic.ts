export type ImageSize = { width: number; height: number };
export type ImagePan = { x: number; y: number };
export function imageFit(image: ImageSize, viewport: ImageSize) {
  if (
    ![image.width, image.height, viewport.width, viewport.height].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return 1;
  return Math.min(viewport.width / image.width, viewport.height / image.height);
}
export function clampImagePan(
  pan: ImagePan,
  image: ImageSize,
  viewport: ImageSize,
  scale: number,
): ImagePan {
  const x = Math.max(0, (image.width * scale - viewport.width) / 2);
  const y = Math.max(0, (image.height * scale - viewport.height) / 2);
  return {
    x: Math.max(-x, Math.min(x, pan.x)),
    y: Math.max(-y, Math.min(y, pan.y)),
  };
}
export function zoomImage(
  oldScale: number,
  requested: number,
  pan: ImagePan,
  anchor: ImagePan,
  image: ImageSize,
  viewport: ImageSize,
) {
  const fit = imageFit(image, viewport);
  const scale = Math.max(fit / 4, Math.min(Math.max(8, fit * 8), requested));
  return {
    scale,
    pan: clampImagePan(
      {
        x: anchor.x - ((anchor.x - pan.x) * scale) / oldScale,
        y: anchor.y - ((anchor.y - pan.y) * scale) / oldScale,
      },
      image,
      viewport,
      scale,
    ),
  };
}
