import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, decodeBridgeEnvelope } from "./bridge";
import { defaultProfile } from "./types";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.onopen?.(); }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  binaryMessage(value: ArrayBuffer) { this.onmessage?.({ data: value }); }
}

describe("BridgeClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  it("connects to the forwarded port, sends hello, and returns remote identity", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect({ ...defaultProfile, localPort: 19001 });
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("ws://127.0.0.1:19001");
    socket.open();
    expect(JSON.parse(socket.sent[0])).toEqual({ op: "hello" });
    socket.message({
      op: "hello",
      bridge_version: "0.1.0",
      bridge_build_id: "abc1234def56",
      ros_distro: "humble",
    });
    await expect(connected).resolves.toEqual({
      bridge_version: "0.1.0",
      bridge_build_id: "abc1234def56",
      ros_distro: "humble",
    });
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("decodes a binary image envelope without Base64 copying", async () => {
    const metadata = new TextEncoder().encode(JSON.stringify({
      op: "topic_message",
      topic: "/camera/color/image_raw",
      data: { width: 1, height: 1, encoding: "rgb8", step: 3, data_length: 3 },
    }));
    const frame = new Uint8Array(8 + metadata.length + 3);
    frame.set([0x52, 0x43, 0x49, 0x31]);
    new DataView(frame.buffer).setUint32(4, metadata.length, false);
    frame.set(metadata, 8);
    frame.set([4, 5, 6], 8 + metadata.length);

    const decoded = decodeBridgeEnvelope(frame.buffer);

    expect(decoded).toMatchObject({ op: "topic_message", topic: "/camera/color/image_raw" });
    expect([...(decoded.data as { data_bytes: Uint8Array }).data_bytes]).toEqual([4, 5, 6]);
  });

  it("correlates request responses and lists topics", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect(defaultProfile);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
    await connected;
    const listed = bridge.listTopics();
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(request.op).toBe("topics");
    expect(request.request_id).toBeTruthy();
    socket.message({ op: "topics", request_id: request.request_id, topics: [{ name: "/a", types: ["std_msgs/msg/String"] }] });
    await expect(listed).resolves.toEqual([{ name: "/a", types: ["std_msgs/msg/String"] }]);
  });

  it("requests ROS node/topic graph topology", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect(defaultProfile);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
    await connected;
    const graph = bridge.getGraph();
    const request = JSON.parse(socket.sent.at(-1)!);
    expect(request.op).toBe("graph");
    socket.message({
      op: "graph",
      request_id: request.request_id,
      nodes: [{ id: "topic:/joint_states", label: "/joint_states", kind: "topic", types: ["sensor_msgs/msg/JointState"] }],
      edges: [{ source: "node:/driver", target: "topic:/joint_states", relation: "publish" }],
    });
    await expect(graph).resolves.toEqual({
      nodes: [{ id: "topic:/joint_states", label: "/joint_states", kind: "topic", types: ["sensor_msgs/msg/JointState"] }],
      edges: [{ source: "node:/driver", target: "topic:/joint_states", relation: "publish" }],
    });
  });

  it("requests topic endpoint QoS and node details with correlated responses", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect(defaultProfile);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
    await connected;
    const topicDetails = bridge.getTopicInfo("/stm32/joint_commands");
    const topicRequest = JSON.parse(socket.sent.at(-1)!);
    expect(topicRequest).toMatchObject({ op: "topic_info", topic: "/stm32/joint_commands" });
    socket.message({ op: "topic_info", request_id: topicRequest.request_id, topic_info: { name: "/stm32/joint_commands", types: [], publishers: [], subscriptions: [] } });
    await expect(topicDetails).resolves.toMatchObject({ name: "/stm32/joint_commands" });

    const nodeDetails = bridge.getNodeInfo("/driver");
    const nodeRequest = JSON.parse(socket.sent.at(-1)!);
    expect(nodeRequest).toMatchObject({ op: "node_info", node: "/driver" });
    socket.message({ op: "node_info", request_id: nodeRequest.request_id, node_info: { name: "/driver", namespace: "/", publishers: [], subscriptions: [], services: [], clients: [] } });
    await expect(nodeDetails).resolves.toMatchObject({ name: "/driver" });
  });

  it("rejects bridge errors and emits topic/disconnect events", async () => {
    const bridge = new BridgeClient();
    const connected = bridge.connect(defaultProfile);
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
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

  it("supports a longer timeout for large URDF resources", async () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    try {
      const bridge = new BridgeClient();
      const connected = bridge.connect(defaultProfile);
      const socket = FakeWebSocket.instances[0];
      socket.open();
      socket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
      await connected;
      const pending = bridge.request({ op: "resource", uri: "package://robot/large.stl" }, 30_000);
      const request = JSON.parse(socket.sent.at(-1)!);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
      socket.message({ op: "resource", request_id: request.request_id, base64: "AQID" });
      await expect(pending).resolves.toMatchObject({ base64: "AQID" });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects pending requests and ignores messages from a closed session", async () => {
    const bridge = new BridgeClient();
    const firstConnection = bridge.connect(defaultProfile);
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    firstSocket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
    await firstConnection;
    const listener = vi.fn();
    bridge.onMessage(listener);
    const pending = bridge.request({ op: "resource", uri: "package://robot/old.stl" });

    bridge.close();
    await expect(pending).rejects.toThrow("Bridge 连接已关闭");

    const secondConnection = bridge.connect(defaultProfile);
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket.open();
    secondSocket.message({ op: "hello", bridge_version: "0.1.0", bridge_build_id: "testbuild0001", ros_distro: "humble" });
    await secondConnection;
    firstSocket.message({ op: "topic_message", topic: "/old", data: 1 });
    secondSocket.message({ op: "topic_message", topic: "/new", data: 2 });

    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ topic: "/old" }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ topic: "/new" }));
  });

  it("throws if sending while disconnected", () => {
    expect(() => new BridgeClient().send({ op: "hello" })).toThrow("Bridge 尚未连接");
  });
});
