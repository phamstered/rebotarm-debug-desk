import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, it, expect, vi } from "vitest";
import {
  HandeyeCalibrationPage,
  useHandeyeSession,
} from "./HandeyeCalibrationPage";
import { defaultProfile } from "./types";
import type { BridgeClient } from "./bridge";
import { captureFixture, detectionFixture } from "./handeyeTestFixtures";
const doubles = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: doubles.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: doubles.save }));
vi.mock("./RosImagePreview", () => ({
  RosImagePreview: () => <div>实时图像</div>,
}));
const bridge = {
  onMessage: vi.fn(() => () => {}),
  request: vi.fn().mockResolvedValue({}),
} as unknown as BridgeClient;
beforeEach(() => {
  vi.clearAllMocks();
  doubles.invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "handeye_capture"
        ? structuredClone(captureFixture)
        : structuredClone(detectionFixture),
    ),
  );
});
it("follows RViz tabs, requires board confirmation, samples and deletes without motion", async () => {
  const user = userEvent.setup();
  render(
    <HandeyeCalibrationPage
      profile={defaultProfile}
      bridge={bridge}
      connected
      active
      onMotion={() => {}}
    />,
  );
  await user.click(screen.getByRole("tab", { name: "Calibrate · 采样求解" }));
  expect(
    screen.getByRole("button", { name: "Take sample · 采样" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("tab", { name: "Target · 标定板" }));
  await user.click(screen.getByLabelText("已核对实体标定板布局及实测尺寸"));
  await user.click(screen.getByRole("tab", { name: "Calibrate · 采样求解" }));
  await user.click(screen.getByRole("button", { name: "Take sample · 采样" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "#1" })).toBeInTheDocument(),
  );
  expect(doubles.invoke).toHaveBeenCalledWith(
    "handeye_capture",
    expect.objectContaining({
      config: expect.objectContaining({
        mode: "capture",
        base_frame: "base_link",
        eef_frame: "link6",
      }),
    }),
  );
  expect(
    doubles.invoke.mock.calls.every(([op]) =>
      ["handeye_capture", "handeye_local"].includes(op),
    ),
  ).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "Delete latest sample" }),
  );
  expect(screen.queryByRole("button", { name: "#1" })).not.toBeInTheDocument();
});
it("discards a capture response after disconnect, preserving the current dataset", async () => {
  const user = userEvent.setup();
  let resolve!: (value: unknown) => void;
  doubles.invoke.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const props = {
    profile: defaultProfile,
    bridge,
    connected: true,
    active: true,
    onMotion: () => {},
  };
  const { rerender } = render(<HandeyeCalibrationPage {...props} />);
  await user.click(screen.getByLabelText("已核对实体标定板布局及实测尺寸"));
  await user.click(screen.getByRole("tab", { name: "Calibrate · 采样求解" }));
  await user.click(screen.getByRole("button", { name: "Take sample · 采样" }));
  rerender(<HandeyeCalibrationPage {...props} connected={false} />);
  await act(async () => resolve(captureFixture));
  expect(doubles.invoke).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "#1" })).not.toBeInTheDocument();
});
it("retains samples when leaving for Motion and coming back", async () => {
  const user = userEvent.setup();
  const props = {
    profile: defaultProfile,
    bridge,
    connected: true,
    active: true,
    onMotion: () => {},
  };
  const { rerender } = render(<HandeyeCalibrationPage {...props} />);
  await user.click(screen.getByLabelText("已核对实体标定板布局及实测尺寸"));
  await user.click(screen.getByRole("tab", { name: "Calibrate · 采样求解" }));
  await user.click(screen.getByRole("button", { name: "Take sample · 采样" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "#1" })).toBeInTheDocument(),
  );
  rerender(<HandeyeCalibrationPage {...props} active={false} />);
  rerender(<HandeyeCalibrationPage {...props} />);
  expect(screen.getByRole("button", { name: "#1" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Solve · 求解 / 复验" }),
  ).toBeDisabled();
});

it("preserves session samples when the connected page unmounts on disconnect", async () => {
  function Harness({ connected }: { connected: boolean }) {
    const session = useHandeyeSession(defaultProfile);
    return connected ? (
      <HandeyeCalibrationPage
        key="connected"
        session={session}
        profile={defaultProfile}
        bridge={bridge}
        connected
        active
        onMotion={() => {}}
      />
    ) : (
      <HandeyeCalibrationPage
        key="offline"
        session={session}
        profile={defaultProfile}
        bridge={bridge}
        connected={false}
        active
        onMotion={() => {}}
      />
    );
  }
  const user = userEvent.setup();
  const { rerender } = render(<Harness connected />);
  await user.click(screen.getByLabelText("已核对实体标定板布局及实测尺寸"));
  await user.click(screen.getByRole("tab", { name: "Calibrate · 采样求解" }));
  await user.click(screen.getByRole("button", { name: "Take sample · 采样" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "#1" })).toBeInTheDocument(),
  );
  rerender(<Harness connected={false} />);
  expect(screen.getByRole("button", { name: "#1" })).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Calibrate · 采样求解" }));
  expect(
    screen.getByRole("button", { name: "Take sample · 采样" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Save samples" })).toBeEnabled();
});
