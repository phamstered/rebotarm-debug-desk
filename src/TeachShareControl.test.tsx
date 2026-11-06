import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeachShareControl } from "./TeachShareControl";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

describe("TeachShareControl", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "teach_share_status") return null;
      if (command === "teach_share_start") return { url: "http://10.0.0.8:17420/teach?token=abc", port: 17420, lanIp: "10.0.0.8", bridgeConnected: true };
      return null;
    });
  });

  it("starts sharing only after opt-in and shows a desk url without a jetson bridge", async () => {
    const user = userEvent.setup();
    render(<TeachShareControl profileKey="jetson|op|22" bridgeConnected />);
    await user.click(screen.getByRole("button", { name: "分享到手机" }));
    expect(invoke).not.toHaveBeenCalledWith("teach_share_start", expect.anything());
    expect(screen.getByText(/手机不连接 Jetson/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "开始分享" }));
    expect(invoke).toHaveBeenCalledWith("teach_share_start", { profileKey: "jetson|op|22" });
    expect(screen.getByLabelText("手机链接")).toHaveValue("http://10.0.0.8:17420/teach?token=abc");
    expect(screen.getByLabelText("手机链接")).not.toHaveValue(expect.stringContaining("bridge="));
  });
});
