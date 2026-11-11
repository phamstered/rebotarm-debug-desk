import { describe, expect, it, vi } from "vitest";
import { bridgeReceivedAt, decodeNativeFrame, NativeBridgeTransport } from "./nativeBridgeLogic";
import type { BridgeEnvelope } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function packet(message: unknown, age = 0, elapsed = 0) {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(17 + body.length);
  new DataView(bytes.buffer).setBigUint64(1, BigInt(age), true);
  new DataView(bytes.buffer).setBigUint64(9, BigInt(elapsed), true);
  bytes.set(body, 17);
  return bytes.buffer;
}
function harness() {
  let incarnation = 0;
  const pulls: ReturnType<typeof deferred<ArrayBuffer>>[] = [];
  const requests: ReturnType<typeof deferred<ArrayBuffer>>[] = [];
  const emitted: BridgeEnvelope[] = [];
  const ipc = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (command === "native_bridge_attach") return { attachment: { epoch: 1, window: { label: "main", incarnation: ++incarnation } }, hello: { op: "hello" } };
    if (command === "native_bridge_next") { const pull = deferred<ArrayBuffer>(); pulls.push(pull); return pull.promise; }
    if (command === "native_bridge_request") { const request = deferred<ArrayBuffer>(); requests.push(request); return request.promise; }
    return undefined;
  });
  const native = new NativeBridgeTransport(message => emitted.push(message), ipc as <T>(command: string, args?: Record<string, unknown>) => Promise<T>);
  return { native, pulls, requests, emitted, ipc };
}

describe("native binary delivery", () => {
  it("preserves queue age plus IPC delay but excludes waiting for the next source frame", () => {
    const message = decodeNativeFrame(packet({ op: "topic_message", topic: "/joints" }, 25, 990), 100, 1100)!;
    expect(bridgeReceivedAt(message, 1100)).toBe(1065);
    expect(1100 - bridgeReceivedAt(message, 1100)).toBe(35);
    expect(bridgeReceivedAt({ op: "topic_message" }, 1100)).toBe(1100);
  });
  it("exposes image bytes directly from the IPC buffer", () => {
    const meta = new TextEncoder().encode(JSON.stringify({ op: "topic_message", data: { data_length: 3 } }));
    const bytes = new Uint8Array(17 + 8 + meta.length + 3);
    bytes[0] = 1;
    bytes.set([82, 67, 73, 49], 17);
    new DataView(bytes.buffer).setUint32(21, meta.length, false);
    bytes.set(meta, 25);
    bytes.set([1, 2, 255], 25 + meta.length);
    const message = decodeNativeFrame(bytes.buffer, 0, 0)!;
    const image = (message.data as { data_bytes: Uint8Array }).data_bytes;
    expect(image.buffer).toBe(bytes.buffer);
    expect([...image]).toEqual([1, 2, 255]);
  });
  it("rejects malformed headers, clocks and unbounded integer ages", () => {
    expect(decodeNativeFrame(new ArrayBuffer(0), 0, 0)).toBeNull();
    expect(() => decodeNativeFrame(new ArrayBuffer(8), 0, 0)).toThrow("帧头");
    const bytes = packet({ op: "hello" }); new Uint8Array(bytes)[0] = 2;
    expect(() => decodeNativeFrame(bytes, 0, 0)).toThrow("类型");
    expect(() => decodeNativeFrame(packet({ op: "hello" }), 2, 1)).toThrow("帧龄");
    const invalid = packet({ op: "hello" }); new DataView(invalid).setBigUint64(1, 2n ** 63n, true);
    expect(() => decodeNativeFrame(invalid, 0, 0)).toThrow("帧龄");
  });
});

describe("native Bridge window adapter", () => {
  it("has one outstanding pull, carries consumer identity and preserves caller correlation", async () => {
    const h = harness(); await h.native.connect(18765);
    expect(h.pulls).toHaveLength(1);
    const request = h.native.request({ op: "subscribe", topic: "/rgb", type: "sensor_msgs/msg/Image", request_id: "ui-1" }, 10000, undefined, "handeye");
    expect(h.ipc).toHaveBeenLastCalledWith("native_bridge_request", expect.objectContaining({ consumer: "handeye", attachment: { epoch: 1, window: { label: "main", incarnation: 1 } } }));
    h.requests[0].resolve(packet({ op: "subscribed", request_id: "internal-17" }));
    expect((await request).request_id).toBe("ui-1");
    h.pulls[0].resolve(packet({ op: "topic_message", topic: "/rgb", data: 1 }));
    await vi.waitFor(() => expect(h.pulls).toHaveLength(2));
    expect(h.emitted.filter(m => m.op === "topic_message")).toHaveLength(1);
    h.native.close();
  });
  it("close promptly rejects requests and fences old pull/response completions after reconnect", async () => {
    const h = harness(); await h.native.connect(18765);
    const request = h.native.request({ op: "topics" });
    const rejected = expect(request).rejects.toThrow("关闭");
    h.native.close(); await rejected;
    await h.native.connect(18765);
    h.requests[0].resolve(packet({ op: "topics", topics: [{ name: "/old" }] }));
    h.pulls[0].resolve(packet({ op: "topic_message", topic: "/old" }));
    await Promise.resolve(); await Promise.resolve();
    expect(h.emitted.some(m => m.op === "topics" || m.topic === "/old")).toBe(false);
    h.pulls[1].resolve(packet({ op: "topic_message", topic: "/new" }));
    await vi.waitFor(() => expect(h.emitted.some(m => m.topic === "/new")).toBe(true));
    h.native.close();
  });
  it("abort ignores late replies and async send failures preserve stream request IDs", async () => {
    const h = harness(); await h.native.connect(18765);
    const abort = new AbortController();
    const request = h.native.request({ op: "resource" }, 30000, abort.signal);
    abort.abort(); await expect(request).rejects.toMatchObject({ name: "AbortError" });
    h.requests[0].resolve(packet({ op: "resource" }));
    h.native.send({ op: "subscribe_rgbd", request_id: "rgbd-lease" });
    h.requests[1].reject(new Error("subscription unavailable"));
    await vi.waitFor(() => expect(h.emitted).toContainEqual(expect.objectContaining({ op: "error", request_id: "rgbd-lease" })));
    h.native.close();
  });
  it("a closed window's failed send cannot contaminate its replacement", async () => {
    const h = harness(); await h.native.connect(18765);
    h.native.send({ op: "subscribe_rgbd", request_id: "old" });
    h.native.close(); await h.native.connect(18765);
    h.requests[0].reject(new Error("old connection"));
    await Promise.resolve(); await Promise.resolve();
    expect(h.emitted.some(m => m.op === "error")).toBe(false);
    h.native.close();
  });
  it("malformed delivery fails the window and stops requesting more frames", async () => {
    const h = harness(); await h.native.connect(18765);
    h.pulls[0].resolve(new ArrayBuffer(3));
    await vi.waitFor(() => expect(h.emitted.some(m => m.op === "disconnected")).toBe(true));
    expect(h.pulls).toHaveLength(1);
    expect(() => h.native.send({ op: "topics" })).toThrow("尚未连接");
  });
});

it("serializes replacement attachment behind cancellation cleanup of an in-flight attach", async () => {
  const first = deferred<unknown>(); const detached = deferred<unknown>();
  const calls: string[] = []; let attaches = 0;
  const ipc = async (op: string) => {
    calls.push(op);
    if (op === "native_bridge_attach") { if (++attaches === 1) return first.promise; return { attachment: { epoch: 2, window: { label: "page-handeye", incarnation: 2 } }, hello: { op: "hello" } }; }
    if (op === "native_bridge_detach") return detached.promise;
    if (op === "native_bridge_next") return new Promise(() => {});
  };
  const native = new NativeBridgeTransport(() => {}, ipc as <T>(op: string) => Promise<T>);
  const old = native.connect(); const oldFailure = expect(old).rejects.toThrow("取消");
  await vi.waitFor(() => expect(attaches).toBe(1));
  const next = native.connect();
  first.resolve({ attachment: { epoch: 1, window: { label: "page-handeye", incarnation: 1 } }, hello: { op: "hello" } });
  await vi.waitFor(() => expect(calls).toContain("native_bridge_detach"));
  expect(attaches).toBe(1);
  detached.resolve(undefined); await oldFailure; await next;
  expect(calls.slice(0, 3)).toEqual(["native_bridge_attach", "native_bridge_detach", "native_bridge_attach"]);
  native.close();
});
