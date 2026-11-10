import { describe, expect, it } from "vitest";
import { imageFit, clampImagePan, zoomImage } from "./handeyeImageLogic";
describe("hand-eye image inspection geometry", () => {
  const image = { width: 1280, height: 720 },
    view = { width: 640, height: 400 };
  it("fits wide and portrait images without distortion", () => {
    expect(imageFit(image, view)).toBe(0.5);
    expect(imageFit({ width: 300, height: 1200 }, view)).toBeCloseTo(1 / 3);
    expect(imageFit({ width: 0, height: 0 }, view)).toBe(1);
  });
  it("keeps the image within panning bounds and recentres when it fits", () => {
    expect(clampImagePan({ x: 1000, y: -1000 }, image, view, 1)).toEqual({
      x: 320,
      y: -160,
    });
    expect(clampImagePan({ x: 100, y: 100 }, image, view, 0.5)).toEqual({
      x: 0,
      y: 0,
    });
  });
  it("preserves the pixel under the pointer during zoom and bounds scale", () => {
    const result = zoomImage(
      0.5,
      1,
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      image,
      view,
    );
    expect(result).toEqual({ scale: 1, pan: { x: -100, y: -50 } });
    expect((100 - result.pan.x) / result.scale).toBe(100 / 0.5);
    expect(
      zoomImage(1, 100, { x: 0, y: 0 }, { x: 0, y: 0 }, image, view).scale,
    ).toBe(8);
    expect(
      zoomImage(1, 0, { x: 0, y: 0 }, { x: 0, y: 0 }, image, view).scale,
    ).toBe(0.125);
  });
});
