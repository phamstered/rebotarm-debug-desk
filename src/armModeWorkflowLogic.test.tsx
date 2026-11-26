import { readTerminal } from "./terminalLogLogic";
import { act, renderHook, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultProfile } from "./types";
import { useArmModeWorkflow, workflowSteps, type ArmProgress } from "./armModeWorkflowLogic";
import { ArmModeWorkflow } from "./ArmModeWorkflow";

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke, Channel: class { onmessage = (_event: ArmProgress) => {}; } }));

describe("arm mode workflow", () => {
  it("shows planner startup only for Trajectory and independent MoveIt calls", () => {
    expect(workflowSteps("trajectory").map((s) => s.id)).toContain("planner");
    expect(workflowSteps("moveit").map((s) => s.id)).toEqual(["prepare", "planner", "ready"]);
    for (const mode of ["teleop", "vla", "stop", "disable-stop"]) {
      expect(workflowSteps(mode).map((s) => s.id)).not.toContain("planner");
    }
  });
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
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect((await readTerminal(0)).entries.some(e=>e.source==="Controller"&&e.message.includes("owner did not exit"))).toBe(true);
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
    render(<ArmModeWorkflow workflow={{mode: "stop", stage: "cleanup", message: "stopping", failed: false, running: true}} />);
    expect(screen.queryByText("启动控制器")).not.toBeInTheDocument();
    expect(screen.queryByText("核验反馈")).not.toBeInTheDocument();
    expect(screen.getByText("清理旧进程").closest("li")).toHaveAttribute("data-state", "current");
    expect(screen.getByText("完成").closest("li")).toHaveAttribute("data-state", "waiting");
  });

  it("does not invent arm cleanup/startup steps for an independent camera restart", async () => {
    mock.invoke.mockResolvedValue({ok: true, message: "camera ready"});
    const hook = renderHook(() => useArmModeWorkflow(defaultProfile, true));
    await act(async () => { await hook.result.current.run("realsense"); });
    expect(hook.result.current.workflow).toBeNull();
  });
});


it("removes completed steps from the operation area while retaining their diagnostic output", async () => {
  const view = render(<ArmModeWorkflow workflow={{mode:"stop", stage:"cleanup", message:"清理中", failed:false, running:true}} />);
  expect(screen.getByRole("region", {name:"控制器启动流程"})).toBeVisible();
  view.rerender(<ArmModeWorkflow workflow={{mode:"stop", stage:"ready", message:"已核验退出完成", failed:false, running:false}} />);
  expect(screen.queryByRole("region", {name:"控制器启动流程"})).not.toBeInTheDocument();
  expect((await readTerminal(0)).entries.some(e=>e.message==="已核验退出完成")).toBe(true);
});
