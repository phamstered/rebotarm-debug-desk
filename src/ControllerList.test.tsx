import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ControllerList } from "./ControllerList";
const status = { manager: "/controller_manager", fresh: true, available: true, message: "", controllers: [{ name: "arm_trajectory_controller", state: "active", typeName: "joint_trajectory_controller/JointTrajectoryController" }] };
it("shows read-only controller details and navigation without activation controls", async () => {
  const inspect = vi.fn(), manage = vi.fn(), user = userEvent.setup();
  render(<ControllerList status={status} onInspect={inspect} onManage={manage} />);
  expect(screen.getByText("轨迹")).toBeVisible(); expect(screen.getByText("active")).toBeVisible();
  expect(screen.queryByText("Deactivate")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "查看 arm_trajectory_controller Graph" }));
  await user.click(screen.getByRole("button", { name: "管理 arm_trajectory_controller" }));
  expect(inspect).toHaveBeenCalledWith("arm_trajectory_controller"); expect(manage).toHaveBeenCalledWith("arm_trajectory_controller");
});
it("keeps last-good rows visibly read-only with neutral badges, age and query failure",()=>{
  render(<ControllerList status={{...status,fresh:false,available:false,hasSnapshot:true,snapshotAgeMs:4200,queryState:"timeout",message:"ListControllers >2s",queryPending:true,retryAfterMs:1000}} onInspect={vi.fn()}/>);
  expect(screen.getByRole("status")).toHaveTextContent("查询超时");
  expect(screen.getByRole("status")).toHaveTextContent("快照年龄 4.2 s · 上次结果，仅供只读查看");
  expect(screen.getByRole("status")).toHaveTextContent("快照已过期");
  expect(screen.getByText("active（上次）")).toHaveClass("unknown");
  expect(screen.getByText("active（上次）")).not.toHaveClass("active");
  expect(screen.getByRole("status")).toHaveTextContent("重试等待 1.0 s");
  expect(screen.getByRole("button",{name:"查看 arm_trajectory_controller Graph"})).toBeEnabled();
});
it("does not describe a healthy polling cooldown as a retry", () => {
  render(<ControllerList status={{...status,hasSnapshot:true,snapshotAgeMs:100,queryState:"ready",retryAfterMs:1000}} onInspect={vi.fn()}/>);
  expect(screen.getByRole("status")).toHaveTextContent("快照年龄 0.1 s");
  expect(screen.queryByText(/重试等待/)).not.toBeInTheDocument();
});
