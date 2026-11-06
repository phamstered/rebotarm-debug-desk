import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { TeachPendant } from "./TeachPendant";

const joints = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];

it("saves through the desk relay and never opens a jetson socket", async () => {
  const user = userEvent.setup();
  const sockets: string[] = [];
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === "/api/teach/capture") return json({ captureId: "cap-1", positions: joints, gripperPosition: null });
    if (url === "/api/teach/poses" && init?.method === "POST") return json({ position: { id: "pose-1", name: "姿态 1", positions: joints } });
    if (url === "/api/teach/poses") {
      const saved = calls.some((call) => call.body?.includes("cap-1"));
      return json({ positions: saved ? [{ id: "pose-1", name: "姿态 1", positions: joints, source: "feedback", note: "" }] : [] });
    }
    return json({ error: "no" }, 404);
  });
  render(<TeachPendant
    href="http://10.0.0.8:17420/teach?token=abc"
    fetchImpl={fetchImpl as unknown as typeof fetch}
    openLive={(url, onMessage) => {
      sockets.push(url);
      onMessage(JSON.stringify({ bridgeConnected: true, positions: joints, gripperPosition: null, error: "" }));
      return () => undefined;
    }}
  />);
  expect(sockets).toEqual(["ws://10.0.0.8:17420/api/teach/live?token=abc"]);
  expect(sockets.join(" ")).not.toContain("jetson");
  expect(await screen.findByRole("button", { name: "保存当前姿态" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "保存当前姿态" })).toHaveStyle({ minHeight: "48px" });
  expect(screen.queryByRole("button", { name: /移动|点动|急停/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存当前姿态" }));
  expect(await screen.findByRole("dialog", { name: "保存当前姿态" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "保存点位" }));
  expect(await screen.findByRole("article", { name: "姿态 1" })).toBeVisible();
  const save = calls.find((call) => call.body?.includes("cap-1"));
  expect(save?.body).toContain("\"captureId\":\"cap-1\"");
  expect(save?.body).not.toContain("\"positions\"");
  expect(screen.getByRole("article", { name: "HOME" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "删除 HOME" })).not.toBeInTheDocument();
});

it("shows a desk-side bridge error and does not offer save", async () => {
  render(<TeachPendant
    href="http://10.0.0.8:17420/teach?token=abc"
    fetchImpl={vi.fn(async () => json({ positions: [] })) as unknown as typeof fetch}
    openLive={(_url, onMessage) => {
      onMessage(JSON.stringify({ bridgeConnected: false, positions: null, error: "桌面端尚未连接 Jetson Bridge" }));
      return () => undefined;
    }}
  />);
  expect(await screen.findByRole("button", { name: "保存当前姿态" })).toBeDisabled();
  expect(screen.getByText(/尚未连接 Jetson Bridge/)).toBeVisible();
});

function json(body: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}
