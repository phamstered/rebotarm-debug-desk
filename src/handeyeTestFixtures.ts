import { defaultProfile } from "./types";
import { DEFAULT_BOARD, defaultHandeyeContext } from "./handeyeLogic";
import type {
  HandeyeCapture,
  HandeyeDataset,
  HandeyeDetection,
} from "./handeyeLogic";
export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export const captureFixture: HandeyeCapture = {
  image_png: "iVBORw0KGgoAAA==",
  stamp_ns: "1794326004145118652",
  width: 1280,
  height: 720,
  k: [915, 0, 640, 0, 915, 360, 0, 0, 1],
  d: [0, 0, 0, 0, 0],
  distortion_model: "plumb_bob",
  sensor_frame: "left_arm/wrist_color_optical_frame",
  robot: identity,
  body_to_sensor: identity,
  frame_age_ms: 20,
  joints: { stamp_ns: 1, names: [], positions: [], velocities: [] },
};
export const detectionFixture: HandeyeDetection = {
  target: identity,
  corners: 88,
  corner_ids: [1, 2],
  rms_px: 0.2,
  max_px: 0.7,
  coverage: 0.1,
  annotated_png: "iVBORw0KGgoAAA==",
};
export function datasetFixture(): HandeyeDataset {
  return {
    version: 1,
    board: { ...DEFAULT_BOARD },
    context: defaultHandeyeContext(defaultProfile),
    source_key: "fixture",
    samples: [
      {
        id: "one",
        role: "training",
        capture: structuredClone(captureFixture),
        detection: structuredClone(detectionFixture),
      },
    ],
  };
}
