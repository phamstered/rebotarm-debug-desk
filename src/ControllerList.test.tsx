import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ControllerList } from "./ControllerList";
const status = { manager: "/controller_manager", available: true, message: "", controllers: [{ name: "arm_trajectory_controller", state: "active", typeName: "joint_trajectory_controller/JointTrajectoryController" }] };
it("shows read-only controller details and navigation without activation controls", async () => {
  const inspect = vi.fn(), manage = vi.fn(), user = userEvent.setup();
  render(<ControllerList status={status} onInspect={inspect} onManage={manage} />);
  expect(screen.getByText("轨迹")).toBeVisible(); expect(screen.getByText("active")).toBeVisible();
  expect(screen.queryByText("Deactivate")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "查看 arm_trajectory_controller Graph" }));
  await user.click(screen.getByRole("button", { name: "管理 arm_trajectory_controller" }));
  expect(inspect).toHaveBeenCalledWith("arm_trajectory_controller"); expect(manage).toHaveBeenCalledWith("arm_trajectory_controller");
});
