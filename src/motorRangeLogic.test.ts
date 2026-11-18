import { describe, expect, it } from "vitest";
import { motorRangeFor, parseMotorUrdfRanges } from "./motorRangeLogic";

const gripperName = "gripper_finger_left_joint";
const joint = (name = "joint1", type = "revolute", lower = "-2.8", upper = "2.8", extra = "") => (
  `<joint name="${name}" type="${type}"><limit lower="${lower}" upper="${upper}"/>${extra}</joint>`
);
const model = (body: string) => parseMotorUrdfRanges(`<robot name="test">${body}</robot>`);
const control = (options: { scale?: string; offset?: string; min?: string; max?: string; plugin?: string; hardwareExtra?: string; jointExtra?: string } = {}) => `
  <ros2_control name="arm" type="system">
    <hardware><plugin>${options.plugin ?? "microros_stm32h723_bridge/MicroRosSystem"}</plugin>
      <param name="gripper_position_scale">${options.scale ?? "-0.008612826752"}</param>
      <param name="gripper_position_offset">${options.offset ?? "0.004282757541"}</param>
      ${options.hardwareExtra ?? ""}
    </hardware>
    <joint name="${gripperName}"><command_interface name="position">
      <param name="min">${options.min ?? "0"}</param><param name="max">${options.max ?? "0.05"}</param>
    </command_interface>${options.jointExtra ?? ""}</joint>
  </ros2_control>`;
const gripper = (hardware = control(), lower = "0", upper = "0.0715") => (
  motorRangeFor(model(joint(gripperName, "prismatic", lower, upper) + hardware), gripperName, 6)
);
function expectUnknown(range: ReturnType<typeof motorRangeFor>) {
  expect(range.min).toBeNull();
  expect(range.max).toBeNull();
  expect(range.reason).toBeTruthy();
}

describe("Motor URDF ranges", () => {
  it("resolves revolute limits by name rather than URDF order", () => {
    const parsed = model(joint("joint2", "revolute", "-3.14", "0") + joint("joint1", "revolute", "-1e0", "+2.5"));
    expect(motorRangeFor(parsed, "joint1", 0)).toEqual({ min: -1, max: 2.5, source: "URDF" });
    expect(motorRangeFor(parsed, "joint2", 1)).toEqual({ min: -3.14, max: 0, source: "URDF" });
  });

  it("uses jointN only for a missing name, never for an unexpected supplied name", () => {
    const parsed = model(joint());
    expect(motorRangeFor(parsed, "", 0).min).toBe(-2.8);
    expectUnknown(motorRangeFor(parsed, "unexpected", 0));
    expectUnknown(motorRangeFor(parsed, " ", 0));
    expectUnknown(motorRangeFor(parsed, "", 6));
  });

  it.each(["", "<robot>", "<model/>", "<outer><robot/></outer>", "<robot/><robot/>"])("reports missing or invalid XML without default limits: %s", xml => {
    const parsed = parseMotorUrdfRanges(xml);
    expect(parsed.error).toBeTruthy();
    expectUnknown(motorRangeFor(parsed, "joint1", 0));
  });

  it("reads only top-level model joints, not ros2_control or nested joints", () => {
    const parsed = model(`<ros2_control>${joint()}</ros2_control><group>${joint("joint2")}</group>`);
    expectUnknown(motorRangeFor(parsed, "joint1", 0));
    expectUnknown(motorRangeFor(parsed, "joint2", 1));
  });

  it.each(["", "NaN", "Infinity", "-Infinity", "1oops", "0x10", "1e309"])("rejects missing/nonfinite/invalid bounds: %s", value => {
    expectUnknown(motorRangeFor(model(joint("joint1", "revolute", value, "3")), "joint1", 0));
    expectUnknown(motorRangeFor(model(joint("joint1", "revolute", "-3", value)), "joint1", 0));
  });

  it.each([
    '<joint name="joint1" type="revolute"/>',
    '<joint name="joint1" type="revolute"><limit lower="0"/></joint>',
    '<joint name="joint1" type="revolute"><limit upper="1"/></joint>',
    joint("joint1", "revolute", "1", "1"),
    joint("joint1", "revolute", "2", "1"),
    joint("joint1", "revolute", "0", "1", '<limit lower="0" upper="2"/>'),
  ])("does not invent incomplete or ambiguous model bounds", xml => {
    expectUnknown(motorRangeFor(model(xml), "joint1", 0));
  });

  it("rejects duplicate model names while preserving unrelated valid joints", () => {
    const parsed = model(joint() + joint("joint2") + joint() + joint());
    expect(motorRangeFor(parsed, "joint1", 0).reason).toContain("重复");
    expect(motorRangeFor(parsed, "joint2", 1).min).toBe(-2.8);
  });

  it.each(["fixed", "continuous", "floating", "planar", "unknown"])("does not invent a finite range for %s joints", type => {
    expectUnknown(motorRangeFor(model(joint("joint1", type)), "joint1", 0));
  });

  it("rejects mimic joints even when they have finite limits", () => {
    expectUnknown(motorRangeFor(model(joint("joint1", "revolute", "-1", "1", '<mimic joint="joint2"/>')), "joint1", 0));
    expectUnknown(motorRangeFor(model(joint(gripperName, "prismatic", "0", ".05", "<mimic/>") + control()), gripperName, 6));
  });
});

describe("Motor raw gripper radians", () => {
  it("intersects URDF with calibrated travel, then sorts negative-scale inverse endpoints", () => {
    const range = gripper();
    expect(range.source).toBe("URDF · 标定换算");
    expect(range.min).toBeCloseTo((.05 - .004282757541) / -.008612826752, 10);
    expect(range.max).toBeCloseTo((0 - .004282757541) / -.008612826752, 10);
    expect(range.min).toBeCloseTo(-5.308041573, 7);
    expect(range.max).toBeCloseTo(.497253418, 7);
  });

  it("also preserves a narrower URDF range and handles positive scale", () => {
    expect(gripper(control({ scale: ".01", offset: ".02" }), ".01", ".04"))
      .toEqual({ min: -1, max: 2, source: "URDF · 标定换算" });
  });

  it("does not map other names, aliases, channels or uncalibrated prismatic meters", () => {
    expectUnknown(gripper(""));
    const parsed = model(joint(gripperName, "prismatic", "0", ".0715") + joint("joint7", "prismatic", "0", ".0715") + control());
    expectUnknown(motorRangeFor(parsed, gripperName, 5));
    expectUnknown(motorRangeFor(parsed, "joint7", 6));
    expectUnknown(motorRangeFor(parsed, "", 6));
  });

  it.each(["0", "-0", "", "NaN", "Infinity", "1e-320", "1e-13", "-1e-13"])("rejects unusable scale: %s", scale => {
    expectUnknown(gripper(control({ scale })));
  });

  it.each(["1e-12", "-1e-12"])("accepts the plugin's exact minimum scale magnitude: %s", scale => {
    const result = gripper(control({ scale, offset: "0" }));
    expect(result.source).toBe("URDF · 标定换算");
    expect(result.min).toBe(Number(scale) > 0 ? 0 : -5e10);
    expect(result.max).toBe(Number(scale) > 0 ? 5e10 : -0);
  });

  it.each(["", "NaN", "Infinity", "1e309"])("rejects unusable offset: %s", offset => {
    expectUnknown(gripper(control({ offset })));
  });

  it.each([
    { min: "", max: ".05" }, { min: "0", max: "" },
    { min: "NaN", max: ".05" }, { min: "0", max: "Infinity" },
    { min: ".05", max: "0" }, { min: "0", max: "0" },
    { min: ".0715", max: ".08" }, { min: ".08", max: ".09" },
  ])("requires valid calibrated bounds with a nonempty URDF intersection: %o", options => {
    expectUnknown(gripper(control(options)));
  });

  it("requires scale, offset and calibration bounds in one unique recognized hardware block", () => {
    expectUnknown(gripper(control({ plugin: "mock_components/GenericSystem" })));
    expectUnknown(gripper(control() + control()));
    expectUnknown(gripper(control({ hardwareExtra: '<param name="gripper_position_scale">-.01</param>' })));
    expectUnknown(gripper(control({ jointExtra: '<command_interface name="position"><param name="min">0</param><param name="max">.05</param></command_interface>' })));
    expectUnknown(gripper(control().replace('<param name="gripper_position_offset">0.004282757541</param>', "")));
    expectUnknown(gripper(control().replace('<param name="min">0</param>', "")));
    expectUnknown(gripper(control().replace('<param name="gripper_position_scale">-0.008612826752</param>', "")
      + '<ros2_control><hardware><param name="gripper_position_scale">-.01</param></hardware></ros2_control>'));
  });

  it("rejects duplicate controlled joints, hardware, plugins and range parameters", () => {
    expectUnknown(gripper(control().replace('</ros2_control>', `<joint name="${gripperName}"/></ros2_control>`)));
    expectUnknown(gripper(control().replace('</ros2_control>', '<hardware/></ros2_control>')));
    expectUnknown(gripper(control({ hardwareExtra: '<plugin>microros_stm32h723_bridge/MicroRosSystem</plugin>' })));
    expectUnknown(gripper(control().replace('<param name="min">0</param>', '<param name="min">0</param><param name="min">.01</param>')));
  });

  it("does not treat unexpanded xacro content as calibration", () => {
    const xml = `<robot xmlns:xacro="http://www.ros.org/wiki/xacro">${joint(gripperName, "prismatic", "0", ".0715")}<xacro:if value="true">${control()}</xacro:if></robot>`;
    expectUnknown(motorRangeFor(parseMotorUrdfRanges(xml), gripperName, 6));
  });
});
