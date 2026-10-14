import type { BridgeEnvelope, ConnectionProfile, NodeDetails, RosGraph, TopicDetails, TopicInfo } from "./types";

type Listener = (message: BridgeEnvelope) => void;

const IMAGE_MAGIC = [0x52, 0x43, 0x49, 0x31]; // RCI1

export function decodeBridgeEnvelope(payload: string | ArrayBuffer): BridgeEnvelope {
  if (typeof payload === "string") return JSON.parse(payload) as BridgeEnvelope;
  const bytes = new Uint8Array(payload);
  if (bytes.length < 8 || !IMAGE_MAGIC.every((value, index) => bytes[index] === value)) {
    throw new Error("未知的 Bridge 二进制消息");
  }
  const metadataLength = new DataView(payload).getUint32(4, false);
  const pixelOffset = 8 + metadataLength;
  if (pixelOffset > bytes.length) throw new Error("Bridge 图像消息不完整");
  const metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(8, pixelOffset))) as BridgeEnvelope;
  if (!metadata.data || typeof metadata.data !== "object") throw new Error("Bridge 图像元数据无效");
  (metadata.data as Record<string, unknown>).data_bytes = bytes.subarray(pixelOffset);
  return metadata;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private pending = new Map<
    string,
    { resolve(message: BridgeEnvelope): void; reject(error: Error): void }
  >();

  private rejectPending(error: Error) {
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  private connectOnce(profile: ConnectionProfile): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${profile.localPort}`);
      socket.binaryType = "arraybuffer";
      let opened = false;
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error("Bridge WebSocket 连接超时"));
      }, 8000);
      socket.onopen = () => {
        opened = true;
        window.clearTimeout(timer);
        this.socket = socket;
        this.send({ op: "hello" });
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error("无法连接 Jetson Bridge"));
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        const message = decodeBridgeEnvelope(event.data as string | ArrayBuffer);
        if (message.request_id && this.pending.has(message.request_id)) {
          const pending = this.pending.get(message.request_id)!;
          if (message.op === "error") pending.reject(new Error(message.message ?? "Bridge 请求失败"));
          else pending.resolve(message);
          this.pending.delete(message.request_id);
        }
        this.listeners.forEach((listener) => listener(message));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.rejectPending(new Error("Bridge 连接已断开"));
        if (opened) this.listeners.forEach((listener) => listener({ op: "disconnected" }));
      };
    });
  }

  async connect(profile: ConnectionProfile): Promise<void> {
    let lastError: unknown = new Error("Bridge 尚未就绪");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await this.connectOnce(profile);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
    }
    throw lastError;
  }

  close() {
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

  request(message: BridgeEnvelope, timeoutMs = 10000): Promise<BridgeEnvelope> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${message.op} 请求超时`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (response) => {
          window.clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...message, request_id: requestId });
    });
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
