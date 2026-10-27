import type { BridgeEnvelope, ConnectionProfile, NodeDetails, RosGraph, TopicDetails, TopicInfo } from "./types";

export type BridgeHello = {
  bridge_version?: string;
  bridge_build_id?: string;
  ros_distro?: string;
};

import { decodeBase64 } from "./urdfLogic";
import { SessionResourceCache, loadAborted } from "./resourceCacheLogic";

type Listener = (message: BridgeEnvelope) => void;

const IMAGE_MAGIC = [0x52, 0x43, 0x49, 0x31]; // RCI1
const RESOURCE_MAGIC = [0x52, 0x43, 0x52, 0x31]; // RCR1
const RGBD_MAGIC = [0x52, 0x43, 0x44, 0x31]; // RCD1

export function decodeBridgeEnvelope(payload: string | ArrayBuffer): BridgeEnvelope {
  if (typeof payload === "string") return JSON.parse(payload) as BridgeEnvelope;
  const bytes = new Uint8Array(payload);
  const image = IMAGE_MAGIC.every((value, index) => bytes[index] === value);
  const resource = RESOURCE_MAGIC.every((value, index) => bytes[index] === value);
  const rgbd = RGBD_MAGIC.every((value, index) => bytes[index] === value);
  if (bytes.length < 8 || (!image && !resource && !rgbd)) throw new Error("未知的 Bridge 二进制消息");
  const metadataLength = new DataView(payload).getUint32(4, false);
  const offset = 8 + metadataLength;
  if (offset > bytes.length) throw new Error("Bridge 二进制元数据不完整");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(8, offset))) as BridgeEnvelope;
  if (resource) {
    if (metadata.op !== "resource" || !metadata.request_id || !metadata.uri || metadata.data_length !== bytes.length - offset) {
      throw new Error("Bridge 资源帧长度或元数据无效");
    }
    metadata.resource_bytes = bytes.subarray(offset);
  } else if (rgbd) {
    if (metadata.op !== "rgbd_frame") throw new Error("Bridge RGBD 元数据无效");
    const expected = Number(metadata.data_length ?? bytes.length - offset);
    if (expected !== bytes.length - offset) throw new Error("Bridge RGBD 帧长度无效");
    metadata.rgbd_payload = bytes.subarray(offset);
  } else {
    if (metadata.op !== "topic_message" || !metadata.data || typeof metadata.data !== "object") throw new Error("Bridge 图像元数据无效");
    (metadata.data as Record<string, unknown>).data_bytes = bytes.subarray(offset);
  }
  return metadata;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private resources = new SessionResourceCache();
  private listeners = new Set<Listener>();
  private pending = new Map<
    string,
    { resolve(message: BridgeEnvelope): void; reject(error: Error): void }
  >();

  private rejectPending(error: Error) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  private connectOnce(profile: ConnectionProfile): Promise<BridgeHello> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${profile.localPort}`);
      socket.binaryType = "arraybuffer";
      let opened = false;
      let helloResolved = false;
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error(opened ? "Bridge hello 超时" : "Bridge WebSocket 连接超时"));
      }, 8000);
      const finishHello = (hello: BridgeHello) => {
        if (helloResolved) return;
        helloResolved = true;
        window.clearTimeout(timer);
        resolve(hello);
      };
      socket.onopen = () => {
        opened = true;
        this.socket = socket;
        this.send({ op: "hello" });
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("无法连接 Jetson Bridge"));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        let message: BridgeEnvelope;
        try { message = decodeBridgeEnvelope(event.data as string | ArrayBuffer); }
        catch (reason) { this.rejectPending(new Error(`Bridge 协议错误：${String(reason)}`)); socket.close(); return; }
        if (message.request_id && this.pending.has(message.request_id)) {
          const pending = this.pending.get(message.request_id)!;
          if (message.op === "error") pending.reject(new Error(message.message ?? "Bridge 请求失败"));
          else pending.resolve(message);
          this.pending.delete(message.request_id);
        }
        if (message.op !== "resource") this.listeners.forEach((listener) => listener(message));
        if (!helloResolved && message.op === "hello") {
          finishHello({
            bridge_version: message.bridge_version,
            bridge_build_id: message.bridge_build_id,
            ros_distro: message.ros_distro,
          });
        }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.resources.clear();
        this.rejectPending(new Error("Bridge 连接已断开"));
        if (opened) this.listeners.forEach((listener) => listener({ op: "disconnected" }));
        if (!helloResolved) {
          window.clearTimeout(timer);
          reject(new Error("Bridge 连接在 hello 完成前断开"));
        }
      };
    });
  }

  async connect(profile: ConnectionProfile): Promise<BridgeHello> {
    this.close();
    let lastError: unknown = new Error("Bridge 尚未就绪");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        return await this.connectOnce(profile);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }
    throw lastError;
  }

  close() {
    this.resources.clear();
    const socket = this.socket;
    this.socket = null;
    this.rejectPending(new Error("Bridge 连接已关闭"));
    socket?.close();
  }

  onMessage(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(message: BridgeEnvelope) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("Bridge 尚未连接");
    }
    this.socket.send(JSON.stringify(message));
  }

  request(message: BridgeEnvelope, timeoutMs = 10000, signal?: AbortSignal): Promise<BridgeEnvelope> {
    if (signal?.aborted) return Promise.reject(loadAborted());
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timer); signal?.removeEventListener("abort", abort);
        this.pending.delete(requestId);
      };
      const abort = () => { cleanup(); reject(loadAborted()); };
      const timer = window.setTimeout(() => { cleanup(); reject(new Error(`${message.op} 请求超时`)); }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (response) => { cleanup(); resolve(response); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ ...message, request_id: requestId }); }
      catch (reason) { cleanup(); reject(reason); }
    });
  }

  getResource(uri: string, signal?: AbortSignal) {
    return this.resources.get(uri, async (requestSignal) => {
      const response = await this.request({ op: "resource", uri, encoding: "binary" }, 30_000, requestSignal);
      if (!response.resource_bytes && response.base64 == null) throw new Error(`Bridge 未返回资源：${uri}`);
      return { bytes: response.resource_bytes ?? decodeBase64(response.base64!), mime: response.mime ?? "application/octet-stream" };
    }, signal);
  }

  async listTopics(): Promise<TopicInfo[]> {
    const response = await this.request({ op: "topics" });
    return response.topics ?? [];
  }

  async getGraph(): Promise<RosGraph> {
    const response = await this.request({ op: "graph" });
    return { nodes: response.nodes ?? [], edges: response.edges ?? [] };
  }

  async getTopicInfo(topic: string): Promise<TopicDetails> {
    const response = await this.request({ op: "topic_info", topic });
    if (!response.topic_info) throw new Error("Bridge 未返回 Topic 详情");
    return response.topic_info;
  }

  async getNodeInfo(node: string): Promise<NodeDetails> {
    const response = await this.request({ op: "node_info", node });
    if (!response.node_info) throw new Error("Bridge 未返回 Node 详情");
    return response.node_info;
  }
}
