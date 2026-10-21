import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { TopicSample } from "./appLogic";
import { DataCollectionPage } from "./DataCollectionPage";
import { COLLECTION_STORAGE_KEY, defaultCollectionConfig, type CollectionStatus } from "./dataCollectionLogic";
import { defaultProfile, type HardwareStatus } from "./types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const config = { ...defaultCollectionConfig, repoId: "robot/demo", task: "pick cube" };
const stopped: CollectionStatus = { state: "stopped", managed: false, pid: 0, recording: false, pendingFrames: 0, savedEpisodes: 0, fps: 0, task: "", repoId: "", root: "", message: "", log: "" };
const idle: CollectionStatus = { ...stopped, state: "idle", managed: true, pid: 42, fps: 20, task: config.task, repoId: config.repoId, root: config.root };
const recording: CollectionStatus = { ...idle, state: "recording", recording: true, pendingFrames: 20 };
const trackOk: HardwareStatus = { mode: 1, mode_name: "TRACK", fault_code: 0, last_command_sequence: 7 };
const hold: HardwareStatus = { mode: 0, mode_name: "HOLD", fault_code: 0, last_command_sequence: 7 };
const fault11: HardwareStatus = { mode: 1, mode_name: "TRACK", fault_code: 11, last_command_sequence: 7 };

function freshSample(now = Date.now()): TopicSample {
  return {
    data: { header: { stamp: { sec: 1_700_000_000, nanosec: 1 }, frame_id: "" }, name: ["j1"], position: [0.1] },
    count: 20,
    firstAt: now - 1000,
    lastAt: now,
    hz: 50,
  };
}

function stampSamples(sample = freshSample(), topic = defaultCollectionConfig.stateTopic) {
  return { [topic]: sample };
}

function renderPage(overrides: Partial<ComponentProps<typeof DataCollectionPage>> = {}) {
  const props = {
    profile: defaultProfile,
    topics: [] as { name: string; types: string[] }[],
    rosReady: true,
    hardwareStatus: trackOk,
    topicSamples: stampSamples(),
    ...overrides,
  };
  return { ...render(<DataCollectionPage {...props} />), props };
}

beforeEach(() => { localStorage.clear(); localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(config)); invoke.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("DataCollectionPage", () => {
  it("keeps config editable while the initial status request is pending", async () => {
    let resolveStatus!: (value: CollectionStatus) => void;
    invoke.mockReturnValue(new Promise((resolve) => { resolveStatus = resolve; }));
    const user = userEvent.setup();
    renderPage();
    const task = screen.getByLabelText("任务描述");
    expect(task).toBeEnabled();
    await user.click(task);
    await user.type(task, " carefully");
    await act(async () => resolveStatus(stopped));
    expect(task).toHaveValue("pick cube carefully");
    expect(task).toHaveFocus();
  });

  it("preserves typing and focus through pending, successful and failed periodic polls", async () => {
    vi.useFakeTimers();
    const now = 10_000;
    vi.setSystemTime(now);
    let resolvePoll!: (value: CollectionStatus) => void;
    let rejectPoll!: (reason: Error) => void;
    invoke.mockResolvedValueOnce(stopped)
      .mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve; }))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPoll = reject; }));
    renderPage({ topicSamples: stampSamples(freshSample(now)) });
    await act(async () => Promise.resolve());
    const task = screen.getByLabelText("任务描述");
    task.focus();
    fireEvent.change(task, { target: { value: "pick cube first" } });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(task).toBeEnabled();
    expect(task).toHaveFocus();
    fireEvent.change(task, { target: { value: "pick cube first second" } });
    await act(async () => resolvePoll(stopped));
    expect(task).toHaveValue("pick cube first second");
    expect(task).toHaveFocus();

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(task).toBeEnabled();
    fireEvent.change(task, { target: { value: "pick cube first second third" } });
    await act(async () => rejectPoll(new Error("status unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("status unavailable");
    expect(task).toBeEnabled();
    expect(task).toHaveFocus();
    expect(task).toHaveValue("pick cube first second third");
    expect(JSON.parse(localStorage.getItem(COLLECTION_STORAGE_KEY)!).task).toBe("pick cube first second third");
  });

  it("launches, records, saves and finalizes with distinct controls", async () => {
    invoke.mockImplementation((_command, { action }) => Promise.resolve(action === "status" ? stopped : action === "launch" ? idle : action === "start_episode" ? recording : action === "save_episode" ? { ...idle, savedEpisodes: 1 } : { ...stopped, savedEpisodes: 1, message: "dataset finalized" }));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "启动采集器" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "启动采集器" }));
    expect(invoke).toHaveBeenCalledWith("data_collection_action", { profile: defaultProfile, action: "launch", config });
    expect(screen.getByLabelText("任务描述")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "开始 Episode" }));
    expect(screen.getByText("正在采集")).toBeVisible();
    expect(screen.getByRole("button", { name: "结束并完成数据集" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存为成功" }));
    await user.click(screen.getByRole("button", { name: "结束并完成数据集" }));
    expect(screen.getByText("dataset finalized")).toBeVisible();
    expect(screen.getByLabelText("任务描述")).toBeEnabled();
    expect(invoke.mock.calls.map(([, args]) => args.action)).toEqual(["status", "launch", "start_episode", "save_episode", "finish"]);
  });

  it("requires explicit discard and keeps the failure visible", async () => {
    invoke.mockImplementation((_command, { action }) => action === "status" ? Promise.resolve(recording) : Promise.reject("disk failure"));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("正在采集");
    await user.click(screen.getByRole("button", { name: "丢弃 Episode" }));
    expect(invoke).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "确认丢弃" }));
    expect(screen.getByRole("alert")).toHaveTextContent("disk failure");
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "结束并完成数据集" })).toBeDisabled();
  });

  it("blocks duplicate launch and skips polls while a request is in flight", async () => {
    vi.useFakeTimers();
    const now = 20_000;
    vi.setSystemTime(now);
    let resolveLaunch!: (value: CollectionStatus) => void;
    invoke.mockImplementation((_command, { action }) => action === "status" ? Promise.resolve(stopped) : new Promise((resolve) => { resolveLaunch = resolve; }));
    const { rerender } = renderPage({ topicSamples: stampSamples(freshSample(now)) });
    await act(async () => Promise.resolve());
    const launch = screen.getByRole("button", { name: "启动采集器" });
    fireEvent.click(launch); fireEvent.click(launch);
    expect(screen.getByLabelText("任务描述")).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => resolveLaunch(idle));
    // Keep joint sample fresh after wall-clock advanced under fake timers.
    rerender(<DataCollectionPage profile={defaultProfile} topics={[]} rosReady hardwareStatus={trackOk} topicSamples={stampSamples(freshSample(Date.now()))} />);
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeEnabled();
  });

  it("ignores the old host response after the profile changes", async () => {
    let resolveOld!: (value: CollectionStatus) => void;
    invoke.mockImplementation((_command, { profile }) => profile.host === "new-host" ? Promise.resolve(stopped) : new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = renderPage();
    rerender(<DataCollectionPage profile={{ ...defaultProfile, host: "new-host" }} topics={[]} rosReady hardwareStatus={trackOk} topicSamples={stampSamples()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "启动采集器" })).toBeEnabled());
    await act(async () => resolveOld(recording));
    expect(screen.queryByText("正在采集")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动采集器" })).toBeEnabled();
  });

  it("allows checking and finishing without ROS feedback but gates starting an episode", async () => {
    invoke.mockResolvedValue(idle);
    renderPage({ rosReady: false });
    await screen.findByText("待采集");
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "结束并完成数据集" })).toBeEnabled();
    expect(screen.getByText(/等待 JointState/)).toBeVisible();
  });

  it("surfaces stm32 status and blocks start for HOLD, fault 11, or missing status", async () => {
    invoke.mockResolvedValue(idle);
    const { rerender } = renderPage();
    await screen.findByText("待采集");
    expect(screen.getByLabelText("机械臂与时间戳")).toHaveTextContent("TRACK");
    expect(screen.getByLabelText("机械臂与时间戳")).toHaveTextContent("0 · NONE");
    expect(screen.getByLabelText("机械臂与时间戳")).toHaveTextContent("7");
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeEnabled();

    rerender(<DataCollectionPage profile={defaultProfile} topics={[]} rosReady hardwareStatus={hold} topicSamples={stampSamples()} />);
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/HOLD/);

    rerender(<DataCollectionPage profile={defaultProfile} topics={[]} rosReady hardwareStatus={fault11} topicSamples={stampSamples()} />);
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/故障码 11/);

    rerender(<DataCollectionPage profile={defaultProfile} topics={[]} rosReady hardwareStatus={null} topicSamples={stampSamples()} />);
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/stm32\/status/);
  });

  it("shows a danger banner when fault appears mid-recording without auto-discard", async () => {
    invoke.mockResolvedValue(recording);
    const { rerender } = renderPage();
    await screen.findByText("正在采集");
    expect(screen.queryByText(/建议丢弃本 Episode/)).not.toBeInTheDocument();

    rerender(<DataCollectionPage profile={defaultProfile} topics={[]} rosReady hardwareStatus={fault11} topicSamples={stampSamples()} />);
    const banner = screen.getByText(/采集中出现故障码 11/);
    expect(banner).toBeVisible();
    expect(banner).toHaveClass("collection-danger-banner");
    expect(banner).toHaveTextContent(/丢弃 Episode/);
    expect(invoke.mock.calls.every(([, args]) => args.action !== "discard_episode")).toBe(true);
  });

  it("samples stamp health from config.stateTopic, not a different profile joint topic", async () => {
    invoke.mockResolvedValue(idle);
    const now = Date.now();
    const good = freshSample(now);
    const zero = { ...freshSample(now), data: { header: { stamp: { sec: 0, nanosec: 0 } } } };
    renderPage({
      topicSamples: {
        "/stm32/joint_states": good,
        "/joint_states": zero,
      },
    });
    await screen.findByText("待采集");
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeEnabled();
    expect(screen.getByLabelText("机械臂与时间戳")).toHaveTextContent("时间戳可用");
  });
});
