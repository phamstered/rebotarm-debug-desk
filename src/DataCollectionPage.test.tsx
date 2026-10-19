import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataCollectionPage } from "./DataCollectionPage";
import { COLLECTION_STORAGE_KEY, defaultCollectionConfig, type CollectionStatus } from "./dataCollectionLogic";
import { defaultProfile } from "./types";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const config = { ...defaultCollectionConfig, repoId: "robot/demo", task: "pick cube" };
const stopped: CollectionStatus = { state: "stopped", managed: false, pid: 0, recording: false, pendingFrames: 0, savedEpisodes: 0, fps: 0, task: "", repoId: "", root: "", message: "", log: "" };
const idle: CollectionStatus = { ...stopped, state: "idle", managed: true, pid: 42, fps: 20, task: config.task, repoId: config.repoId, root: config.root };
const recording: CollectionStatus = { ...idle, state: "recording", recording: true, pendingFrames: 20 };
const props = { profile: defaultProfile, topics: [], rosReady: true };

beforeEach(() => { localStorage.clear(); localStorage.setItem(COLLECTION_STORAGE_KEY, JSON.stringify(config)); invoke.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("DataCollectionPage", () => {
  it("launches, records, saves and finalizes with distinct controls", async () => {
    invoke.mockImplementation((_command, { action }) => Promise.resolve(action === "status" ? stopped : action === "launch" ? idle : action === "start_episode" ? recording : action === "save_episode" ? { ...idle, savedEpisodes: 1 } : { ...stopped, savedEpisodes: 1, message: "dataset finalized" }));
    const user = userEvent.setup();
    render(<DataCollectionPage {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "启动采集器" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "启动采集器" }));
    expect(invoke).toHaveBeenCalledWith("data_collection_action", { profile: defaultProfile, action: "launch", config });
    expect(screen.getByLabelText("任务描述")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "开始 Episode" }));
    expect(screen.getByText("正在采集")).toBeVisible();
    expect(screen.getByRole("button", { name: "结束并完成数据集" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存成功 Episode" }));
    await user.click(screen.getByRole("button", { name: "结束并完成数据集" }));
    expect(screen.getByText("dataset finalized")).toBeVisible();
    expect(screen.getByLabelText("任务描述")).toBeEnabled();
    expect(invoke.mock.calls.map(([, args]) => args.action)).toEqual(["status", "launch", "start_episode", "save_episode", "finish"]);
  });

  it("requires explicit discard and keeps the failure visible", async () => {
    invoke.mockImplementation((_command, { action }) => action === "status" ? Promise.resolve(recording) : Promise.reject("disk failure"));
    const user = userEvent.setup();
    render(<DataCollectionPage {...props} />);
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
    let resolveLaunch!: (value: CollectionStatus) => void;
    invoke.mockImplementation((_command, { action }) => action === "status" ? Promise.resolve(stopped) : new Promise((resolve) => { resolveLaunch = resolve; }));
    render(<DataCollectionPage {...props} />);
    await act(async () => Promise.resolve());
    const launch = screen.getByRole("button", { name: "启动采集器" });
    fireEvent.click(launch); fireEvent.click(launch);
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(invoke).toHaveBeenCalledTimes(2);
    await act(async () => resolveLaunch(idle));
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeEnabled();
  });

  it("ignores the old host response after the profile changes", async () => {
    let resolveOld!: (value: CollectionStatus) => void;
    invoke.mockImplementation((_command, { profile }) => profile.host === "new-host" ? Promise.resolve(stopped) : new Promise((resolve) => { resolveOld = resolve; }));
    const { rerender } = render(<DataCollectionPage {...props} />);
    rerender(<DataCollectionPage {...props} profile={{ ...defaultProfile, host: "new-host" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "启动采集器" })).toBeEnabled());
    await act(async () => resolveOld(recording));
    expect(screen.queryByText("正在采集")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动采集器" })).toBeEnabled();
  });

  it("allows checking and finishing without ROS feedback but gates starting an episode", async () => {
    invoke.mockResolvedValue(idle);
    render(<DataCollectionPage {...props} rosReady={false} />);
    await screen.findByText("待采集");
    expect(screen.getByRole("button", { name: "开始 Episode" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "结束并完成数据集" })).toBeEnabled();
  });
});
