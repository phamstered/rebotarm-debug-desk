import { act, renderHook, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { useArmModeWorkflow, type ArmProgress } from "./armModeWorkflowLogic";
import { ArmModeWorkflow } from "./ArmModeWorkflow";

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, Channel: class { onmessage = (_event: ArmProgress) => {}; } }));

describe("arm mode workflow", () => {
  it("uses actual native events and freezes failures at the current step", async () => {
    let complete!: (v: unknown) => void;
    mock.invoke.mockImplementation((_name, args) => new Promise((resolve) => { complete = resolve; args.onProgress.onmessage({stage: "cleanup", message: "正在清理", failed: false}); }));
    const hook = renderHook(() => useArmModeWorkflow(defaultProfile, true));
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.run("trajectory"); });
    expect(hook.result.current.workflow).toMatchObject({stage: "cleanup", running: true});
    await act(async () => { complete({ ok: false, message: "failed", detail: "owner did not exit" }); await pending; });
    expect(hook.result.current.workflow).toMatchObject({stage: "cleanup", failed: true, running: false});
    render(<ArmModeWorkflow workflow={hook.result.current.workflow} />);
    expect(screen.getByText("清理旧进程").closest("li")).toHaveAttribute("data-state", "failed");
    expect(screen.getByRole("alert")).toHaveTextContent("owner did not exit");
    act(() => { mock.invoke.mock.calls.at(-1)![1].onProgress.onmessage({stage: "startup", message: "late", failed: false}); });
    expect(hook.result.current.workflow?.stage).toBe("cleanup");
  });

  it("discards old operation and connection events, including completion", async () => {
    const operations: Array<{ channel: {onmessage: (v: ArmProgress) => void}; resolve: (v: unknown) => void }> = [];
    mock.invoke.mockImplementation((_name, args) => new Promise((resolve) => { operations.push({ channel: args.onProgress, resolve }); }));
    const hook = renderHook(({ host }) => useArmModeWorkflow({ ...defaultProfile, host }, true), {initialProps: {host: "one"}});
    let pending!: Promise<unknown>;
    act(() => { pending = hook.result.current.run("trajectory"); });
    hook.rerender({host: "two"});
    await act(async () => {
      operations[0].channel.onmessage({stage: "ready", message: "old host", failed: false});
      operations[0].resolve({ok: true, message: "old"}); await pending;
    });
    expect(hook.result.current.workflow).toBeNull();
  });

  it("shows stop as a cleanup flow and never shows fictitious start or verify nodes", () => {
    render(<ArmModeWorkflow workflow={{mode: "stop", stage: "ready", message: "stopped", failed: false, running: false}} />);
    expect(screen.queryByText("启动控制器")).not.toBeInTheDocument();
    expect(screen.queryByText("核验反馈")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem").every((node) => node.getAttribute("data-state") === "done")).toBe(true);
  });

  it("does not invent arm cleanup/startup steps for an independent camera restart", async () => {
    mock.invoke.mockResolvedValue({ok: true, message: "camera ready"});
    const hook = renderHook(() => useArmModeWorkflow(defaultProfile, true));
    await act(async () => { await hook.result.current.run("realsense"); });
    expect(hook.result.current.workflow).toBeNull();
  });
});
