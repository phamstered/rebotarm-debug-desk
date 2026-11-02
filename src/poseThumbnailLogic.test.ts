import { describe, expect, it } from "vitest";
import urdf from "./testFixtures/rebotarm-kinematics.urdf?raw";
import { ARM_JOINT_NAMES, GRIPPER_JOINT_NAME } from "./positionLogic";
import { poseThumbnail, renderPoseThumbnail } from "./poseThumbnailLogic";

const names = [...ARM_JOINT_NAMES];
const zero = [0, 0, 0, 0, 0, 0];
describe("simplified 3D pose thumbnail", () => {
  it("renders shaded surfaces and changes with saved shoulder and wrist rotations", () => {
    const initial = poseThumbnail(urdf, names, zero);
    const bent = poseThumbnail(urdf, names, [0.5, -1.2, -0.8, 0.3, 0.2, 0]);
    const wrist = poseThumbnail(urdf, names, [0, 0, 0, 0, 0, 1]);
    expect(bent.points).not.toEqual(initial.points);
    expect(wrist.toolAxes).not.toEqual(initial.toolAxes);
    const svg = renderPoseThumbnail(initial);
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(10);
    expect(svg.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(renderPoseThumbnail(bent).outerHTML).not.toBe(svg.outerHTML);
    expect(renderPoseThumbnail(wrist).outerHTML).not.toBe(svg.outerHTML);
  });

  it("shows both mimic fingers at the saved opening and omits unknown opening", () => {
    const closed = poseThumbnail(urdf, [...names, GRIPPER_JOINT_NAME], [...zero, 0]);
    const opened = poseThumbnail(urdf, [...names, GRIPPER_JOINT_NAME], [...zero, 0.05]);
    expect(closed.fingers).toHaveLength(2);
    expect(opened.fingers[0]).not.toEqual(closed.fingers[0]);
    expect(opened.fingers[1]).not.toEqual(closed.fingers[1]);
    expect(poseThumbnail(urdf, names, zero).fingers).toEqual([]);
    expect(renderPoseThumbnail(opened).outerHTML).not.toBe(renderPoseThumbnail(closed).outerHTML);
  });

  it.each([
    [names, [0, 0]],
    [names, [NaN, 0, 0, 0, 0, 0]],
    [names, [0, 0, Infinity, 0, 0, 0]],
    [[...names.slice(0, 5), "joint1"], zero],
    [[...names.slice(0, 5), "unknown"], zero],
  ])("rejects incomplete and invalid saved values", (jointNames, values) => {
    expect(() => poseThumbnail(urdf, jointNames as string[], values as number[])).toThrow();
  });

  it("rejects broken or empty robot models", () => {
    expect(() => poseThumbnail("<robot>", names, zero)).toThrow();
    expect(() => poseThumbnail('<robot name="empty"><link name="base" /></robot>', names, zero)).toThrow();
  });
});
