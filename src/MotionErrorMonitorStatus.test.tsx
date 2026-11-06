import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MotionErrorMonitorStatus } from "./MotionErrorMonitorStatus";

afterEach(() => vi.useRealTimers());
it("expires silent streams without another message and reports subscription failures", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const status = { controllerAt: performance.now(), stm32At: performance.now(), tracking: "六轴数据有效", feedback: "六轴数据有效；最新采样，未对齐" };
  const { rerender, unmount } = render(<MotionErrorMonitorStatus status={status} jointStateTopic="/js" liveUpdates />);
  expect(screen.getByRole("status")).toHaveTextContent("六轴数据有效");
  expect(screen.getByLabelText("运动误差数据说明")).toHaveTextContent("JointState Broadcaster /joint_states");
  expect(screen.getByLabelText("运动误差数据说明")).toHaveTextContent("本图保留 STM32 原始反馈");
  act(() => vi.advanceTimersByTime(1250));
  expect(screen.getByRole("status")).toHaveTextContent("反馈已过期");
  rerender(<MotionErrorMonitorStatus status={status} jointStateTopic="/js" liveUpdates subscriptionError="订阅失败：类型不符" />);
  expect(screen.getByRole("status")).toHaveTextContent("订阅失败：类型不符");
  rerender(<MotionErrorMonitorStatus status={status} jointStateTopic="/js" liveUpdates={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("已暂停");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
