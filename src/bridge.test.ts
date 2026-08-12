import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./bridge";
import { defaultProfile } from "./types";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

describe("BridgeClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("connects to the forwarded port and sends hello", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect({ ...defaultProfile, localPort: 19001 });
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("ws://127.0.0.1:19001");
    socket.open();
    await connected;
    expect(JSON.parse(socket.sent[0])).toEqual({ op: "hello" });
  });

  it("correlates request responses and lists topics", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect(defaultProfile);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    const listed = bridge.listTopics();
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(request.op).toBe("topics");
    expect(request.request_id).toBeTruthy();
    socket.message({ op: "topics", request_id: request.request_id, topics: [{ name: "/a", types: ["std_msgs/msg/String"] }] });
    await expect(listed).resolves.toEqual([{ name: "/a", types: ["std_msgs/msg/String"] }]);
  });

  it("rejects bridge errors and emits topic/disconnect events", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect(defaultProfile);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    const listener = vi.fn();
    bridge.onMessage(listener);
    const pending = bridge.request({ op: "resource", uri: "package://x/a.stl" });
    const request = JSON.parse(socket.sent.at(-1)!);
    socket.message({ op: "error", request_id: request.request_id, message: "missing" });
    await expect(pending).rejects.toThrow("missing");
    socket.message({ op: "topic_message", topic: "/a", data: 1 });
    socket.close();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ op: "topic_message", topic: "/a" }));
    expect(listener).toHaveBeenCalledWith({ op: "disconnected" });
  });

  it("throws if sending while disconnected", () => {
    expect(() => new BridgeClient().send({ op: "hello" })).toThrow("Bridge 尚未连接");
  });
});
