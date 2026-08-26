import type { BridgeEnvelope, ConnectionProfile, RosGraph, TopicInfo } from "./types";

type Listener = (message: BridgeEnvelope) => void;

export class BridgeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private pending = new Map<
    string,
    { resolve(message: BridgeEnvelope): void; reject(error: Error): void }
  >();

  private connectOnce(profile: ConnectionProfile): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${profile.localPort}`);
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
        const message = JSON.parse(String(event.data)) as BridgeEnvelope;
        if (message.request_id && this.pending.has(message.request_id)) {
          const pending = this.pending.get(message.request_id)!;
          if (message.op === "error") pending.reject(new Error(message.message ?? "Bridge 请求失败"));
          else pending.resolve(message);
          this.pending.delete(message.request_id);
        }
        this.listeners.forEach((listener) => listener(message));
      };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
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
    this.socket?.close();
    this.socket = null;
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
}
