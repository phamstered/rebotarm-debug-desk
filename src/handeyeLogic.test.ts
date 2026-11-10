import { describe, it, expect } from "vitest";
import { defaultProfile } from "./types";
import {
  DEFAULT_BOARD,
  defaultHandeyeContext,
  handeyeConfigError,
  handeyeExport,
  inverseTransform,
  multiplyTransform,
  parseHandeyeDataset,
  sampleConflict,
  solverRequest,
  validTransform,
} from "./handeyeLogic";
import type {
  HandeyeCapture,
  HandeyeDataset,
  HandeyeDetection,
  HandeyeResult,
} from "./handeyeLogic";
import {
  identity,
  captureFixture,
  datasetFixture,
} from "./handeyeTestFixtures";
describe("hand-eye data and transform conventions", () => {
  it("validates physical board sizes and distinct frames", () => {
    const c = defaultHandeyeContext(defaultProfile);
    expect(handeyeConfigError(DEFAULT_BOARD, c)).toBe("");
    expect(
      handeyeConfigError({ ...DEFAULT_BOARD, marker_m: 0.03 }, c),
    ).not.toBe("");
    expect(
      handeyeConfigError(DEFAULT_BOARD, { ...c, eef_frame: c.base_frame }),
    ).not.toBe("");
    expect(
      handeyeConfigError(DEFAULT_BOARD, { ...c, image_topic: "/x;reboot" }),
    ).not.toBe("");
  });
  it("rejects non-rigid and reflected matrices", () => {
    expect(validTransform(identity)).toBe(true);
    const scaled = [...identity];
    scaled[0] = 2;
    expect(validTransform(scaled)).toBe(false);
    scaled[0] = -1;
    expect(validTransform(scaled)).toBe(false);
    expect(validTransform([...identity, 0])).toBe(false);
  });
  it("inverts rigid transforms and multiplies in parent-child order", () => {
    const m = [0, -1, 0, 0.1, 1, 0, 0, 0.2, 0, 0, 1, 0.3, 0, 0, 0, 1];
    multiplyTransform(m, inverseTransform(m)).forEach((n, i) =>
      expect(n).toBeCloseTo(identity[i], 10),
    );
  });
  it("blocks duplicate frames and insufficient orientation changes", () => {
    const d = datasetFixture();
    expect(sampleConflict(d.samples, captureFixture)).toContain("重复");
    expect(
      sampleConflict(d.samples, { ...captureFixture, stamp_ns: "2" }),
    ).toContain("5°");
    expect(
      sampleConflict(d.samples, {
        ...captureFixture,
        stamp_ns: "2",
        width: 640,
      }),
    ).toContain("内参");
    const body = [...identity];
    body[3] = 0.01;
    expect(
      sampleConflict(d.samples, {
        ...captureFixture,
        stamp_ns: "2",
        body_to_sensor: body,
      }),
    ).toContain("固定变换");
  });
  it("keeps held-out images out of solver training and omits image bytes", () => {
    const d = datasetFixture();
    d.samples.push(
      { ...d.samples[0], id: "two", role: "validation" },
      { ...d.samples[0], id: "three", role: "excluded" },
    );
    const r = solverRequest(d, "PARK");
    expect(r.samples).toHaveLength(1);
    expect(r.validation).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("image_png");
  });
  it("round-trips source timestamps without loss and rejects corrupt imports", () => {
    const d = datasetFixture();
    expect(parseHandeyeDataset(JSON.stringify(d))).toEqual(d);
    d.samples[0].capture.robot[0] = 2;
    expect(() => parseHandeyeDataset(JSON.stringify(d))).toThrow("变换");
  });
  it("rejects duplicate records and unsafe camera metadata", () => {
    const d = datasetFixture();
    d.samples.push({ ...d.samples[0], id: "two" });
    expect(() => parseHandeyeDataset(JSON.stringify(d))).toThrow("时间戳");
    const e = datasetFixture();
    e.samples[0].capture.k[0] = 0;
    expect(() => parseHandeyeDataset(JSON.stringify(e))).toThrow("内参");
  });
  it("exports body transform by removing body-to-optical, never applying it", () => {
    const d = datasetFixture();
    d.samples[0].capture.body_to_sensor[3] = 0.02;
    const solved = [...identity];
    solved[3] = 0.05;
    const r = { transform: solved } as HandeyeResult;
    const output = handeyeExport(d, r);
    expect(output.parent_frame).toBe("link6");
    expect(output.xyz_m[0]).toBeCloseTo(0.03);
    expect(output.plane_verified).toBe(false);
    expect(output.applied).toBe(false);
  });
});

it("exports a finite reconstructible RPY at pitch singularities", () => {
  for (const sign of [-1, 1]) {
    const d = datasetFixture();
    const x = [0, 0, sign, 0, 0, 1, 0, 0, -sign, 0, 0, 0, 0, 0, 0, 1];
    const output = handeyeExport(d, { transform: x } as HandeyeResult);
    expect(output.rpy_rad.every(Number.isFinite)).toBe(true);
    expect(output.rpy_rad[1]).toBeCloseTo((sign * Math.PI) / 2);
    expect(output.rpy_rad[0]).toBeCloseTo(0);
    expect(output.rpy_rad[2]).toBeCloseTo(0);
  }
});
