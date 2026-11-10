import { invoke } from "@tauri-apps/api/core";
import type { BridgeEnvelope } from "./types";
import { decodeBridgeEnvelope } from "./bridgeWireLogic";
import { loadAborted } from "./resourceCacheLogic";

export type NativeAttachment = { epoch: number; window: { label: string; incarnation: number } };
type Attached = { attachment: NativeAttachment; hello: BridgeEnvelope };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Native queue age is not reset when a delayed WebView finally consumes a frame.
 * IPC transit time is conservatively included, excluding native long-poll wait.
 */
export function decodeNativeFrame(bytes: ArrayBuffer, startedAt: number, now = performance.now()): BridgeEnvelope | null {
  if (!bytes.byteLength) return null;
  if (bytes.byteLength < 17) throw new Error("原生 Bridge 帧头不完整");
  const view = new DataView(bytes);
  const binary = view.getUint8(0);
  if (binary > 1) throw new Error("原生 Bridge 帧类型无效");
  const age = Number(view.getBigUint64(1, true));
  if (!Number.isSafeInteger(age) || !Number.isFinite(startedAt) || !Number.isFinite(now) || startedAt > now) throw new Error("原生 Bridge 帧龄无效");
  const nativeElapsed = Number(view.getBigUint64(9, true));
  if (!Number.isSafeInteger(nativeElapsed)) throw new Error("原生 Bridge 耗时无效");
  const payload = new Uint8Array(bytes, 17);
  const message = decodeBridgeEnvelope(binary ? payload : new TextDecoder().decode(payload));
  message.desktop_received_at_ms = Math.min(now, startedAt + nativeElapsed) - age;
  return message;
}

export function bridgeReceivedAt(message: BridgeEnvelope, now = performance.now()): number {
  return Number.isFinite(message.desktop_received_at_ms) ? Math.min(now, message.desktop_received_at_ms!) : now;
}

export class NativeBridgeTransport {
  private attachment: NativeAttachment | null = null;
  private generation = 0;
  private closing: Promise<unknown> = Promise.resolve();
  private pending = new Set<(error: Error) => void>();
  constructor(private emit: (message: BridgeEnvelope) => void, private ipc: Invoke = invoke) {}

  async connect(port?: number): Promise<BridgeEnvelope> {
    this.close();
    const generation = this.generation;
    await this.closing;
    if (generation !== this.generation) throw new Error("连接已被取消");
    const result = await this.ipc<Attached>("native_bridge_attach", { port });
    if (generation !== this.generation) {
      await this.ipc("native_bridge_detach", { attachment: result.attachment });
      throw new Error("连接已被取消");
    }
    this.attachment = result.attachment;
    this.emit(result.hello);
    void this.pump(result.attachment, generation);
    return result.hello;
  }

  private async pump(attachment: NativeAttachment, generation: number) {
    try {
      while (generation === this.generation) {
        const started = performance.now();
        const bytes = await this.ipc<ArrayBuffer>("native_bridge_next", { attachment });
        if (generation !== this.generation) return;
        const message = decodeNativeFrame(bytes, started);
        if (message) this.emit(message);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.close();
      this.emit({ op: "disconnected", message: String(error) });
    }
  }

  close() {
    this.generation++;
    for (const reject of this.pending) reject(new Error("Bridge 会话已关闭"));
    this.pending.clear();
    const attachment = this.attachment;
    this.attachment = null;
    if (attachment) this.closing = this.closing.then(() => this.ipc("native_bridge_detach", { attachment })).catch(() => undefined);
  }

  send(message: BridgeEnvelope, consumer = "default") {
    if (!this.attachment) throw new Error("Bridge 尚未连接");
    const generation = this.generation;
    void this.request(message, 10000, undefined, consumer).catch(error => {
      if (this.attachment && generation === this.generation) this.emit({ op: "error", request_id: message.request_id, message: String(error) });
    });
  }

  request(message: BridgeEnvelope, timeoutMs = 10000, signal?: AbortSignal, consumer = "default"): Promise<BridgeEnvelope> {
    if (signal?.aborted) return Promise.reject(loadAborted());
    const attachment = this.attachment;
    const generation = this.generation;
    if (!attachment) return Promise.reject(new Error("Bridge 尚未连接"));
    // Requests are direct bounded replies; a window's image pull cannot hold up ACKs.
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, result?: BridgeEnvelope) => {
        if (done) return;
        done = true;
        this.pending.delete(cancel);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(loadAborted());
      const cancel = (error: Error) => finish(error);
      this.pending.add(cancel);
      signal?.addEventListener("abort", abort, { once: true });
      void this.ipc<ArrayBuffer>("native_bridge_request", { attachment, consumer, message, timeoutMs })
        .then(bytes => {
          if (done) return;
          if (generation !== this.generation) throw new Error("Bridge 会话已改变");
          // Reply age starts on receipt rather than the start of remote planning.
          const reply = decodeNativeFrame(bytes, started);
          if (!reply) throw new Error("Bridge 返回空响应");
          reply.request_id = message.request_id;
          // Controller freshness includes the request RTT in its existing parser.
          if (reply.op !== "resource") this.emit(reply);
          if (reply.op === "error") throw new Error(reply.message || "Bridge 请求失败");
          finish(undefined, reply);
        }).catch(error => finish(error));
    });
  }
}
