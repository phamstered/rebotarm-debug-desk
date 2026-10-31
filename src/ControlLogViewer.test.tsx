import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { ControlLogViewer } from "./ControlLogViewer";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
const snapshot = (content = "[INFO] ready\n[ERROR] motor\n", source = "teleop") => ({ source, content, path: `/logs/${source}.log`, exists: true, truncated: false, sizeBytes: content.length, revision: content });
const props = { profile: defaultProfile, connected: true, active: true };

beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(snapshot()); mocks.save.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("ControlLogViewer", () => {
  it("keeps search and follow preferences during polling and downloads unfiltered full logs", async () => {
    const user = userEvent.setup();
    render(<ControlLogViewer {...props} />);
    await screen.findByText("[INFO] ready");
    await user.type(screen.getByRole("searchbox", { name: "搜索日志" }), "ERROR");
    expect(screen.getByLabelText("日志输出")).toHaveTextContent("motor");
    expect(screen.getByLabelText("日志输出")).not.toHaveTextContent("ready");
    await user.click(screen.getByRole("checkbox", { name: "跟随最新" }));
    mocks.save.mockResolvedValue("/tmp/control.log");
    await user.click(screen.getByRole("button", { name: "下载完整日志" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("download_control_log", { profile: defaultProfile, source: "teleop", localPath: "/tmp/control.log" }));
    expect(screen.getByRole("searchbox")).toHaveValue("ERROR");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("does not poll hidden tabs; suppresses overlap and discards old source/session responses", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof snapshot>) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<ControlLogViewer {...props} />);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    rerender(<ControlLogViewer {...props} preferredSource="trajectory" />);
    await act(async () => { finish(snapshot("old host output")); });
    expect(screen.queryByText("old host output")).not.toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(mocks.invoke).toHaveBeenLastCalledWith("read_control_log", expect.objectContaining({ source: "trajectory" }));
    rerender(<ControlLogViewer {...props} active={false} />);
    const count = mocks.invoke.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(mocks.invoke).toHaveBeenCalledTimes(count);
    rerender(<ControlLogViewer {...props} connected={false} />);
    expect(screen.getByLabelText("日志输出")).toHaveTextContent("SSH 未连接");
  });

  it("updates output without resetting typed search, stops following when scrolled away", async () => {
    vi.useFakeTimers();
    render(<ControlLogViewer {...props} />);
    await act(async () => {});
    const output = screen.getByLabelText("日志输出");
    Object.defineProperties(output, { scrollHeight: { configurable: true, value: 900 }, clientHeight: { configurable: true, value: 300 } });
    fireEvent.scroll(output, { target: { scrollTop: 100 } });
    expect(screen.getByRole("checkbox")).toBeChecked();
    fireEvent.wheel(output, { deltaY: -100 });
    fireEvent.scroll(output, { target: { scrollTop: 100 } });
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "INFO" } });
    mocks.invoke.mockResolvedValue(snapshot("[INFO] ready\n[INFO] next\n"));
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(output).toHaveTextContent("next");
    expect(screen.getByRole("searchbox")).toHaveValue("INFO");
    expect(output.scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(output.scrollTop).toBe(900);
  });

  it("shows missing logs, read failures, and download failures without stale host content", async () => {
    mocks.invoke.mockResolvedValue({ ...snapshot(), exists: false, content: "" });
    const { rerender } = render(<ControlLogViewer {...props} />);
    await screen.findByText(/日志尚未生成/);
    expect(screen.getByRole("button", { name: "下载完整日志" })).toBeDisabled();
    mocks.invoke.mockRejectedValue(new Error("SSH offline"));
    rerender(<ControlLogViewer {...props} profile={{ ...defaultProfile, host: "other" }} />);
    expect(screen.getByLabelText("日志输出")).not.toHaveTextContent("ready");
    await screen.findByRole("alert");
  });
});

it("reports download failure and skips export when the save dialog is cancelled", async () => {
  const user = userEvent.setup();
  render(<ControlLogViewer {...props} />);
  await screen.findByText("[INFO] ready");
  mocks.save.mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "下载完整日志" }));
  expect(mocks.invoke.mock.calls.some(([name]) => name === "download_control_log")).toBe(false);
  mocks.save.mockResolvedValue("/tmp/control.log");
  mocks.invoke.mockImplementation((name) => name === "download_control_log" ? Promise.reject("disk full") : Promise.resolve(snapshot()));
  await user.click(screen.getByRole("button", { name: "下载完整日志" }));
  expect(await screen.findByText(/日志下载失败.*disk full/)).toBeVisible();
});

it("discards an outstanding read after disconnect or host change", async () => {
  let finish!: (value: ReturnType<typeof snapshot>) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<ControlLogViewer {...props} />);
  rerender(<ControlLogViewer {...props} connected={false} profile={{ ...defaultProfile, host: "other" }} />);
  await act(async () => { finish(snapshot("secret previous session")); });
  expect(screen.getByLabelText("日志输出")).toHaveTextContent("SSH 未连接");
  expect(screen.queryByText("secret previous session")).not.toBeInTheDocument();
});
