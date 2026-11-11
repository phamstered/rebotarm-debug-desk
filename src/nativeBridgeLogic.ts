import { invoke } from "@tauri-apps/api/core";
import type { BridgeEnvelope, ConnectionProfile, NativeMonitorConfig, NativeMonitorPage, MonitorHistoryPage } from "./types";
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
  private connecting: Promise<unknown> = Promise.resolve();
  private pending = new Set<(error: Error) => void>();
  private monitorConfiguration: Promise<unknown> = Promise.resolve();
  private monitorOffset: number | null = null;
  private monitorReading: Promise<MonitorHistoryPage> | null = null;
  constructor(private emit: (message: BridgeEnvelope) => void, private ipc: Invoke = invoke) {}

  connect(port?: number, profile?: ConnectionProfile): Promise<BridgeEnvelope> {
    this.close();
    const generation = this.generation;
    const previous = this.connecting;
    const connect = async () => {
      // A cancelled in-flight attach still owns a native token until its reply
      // can be detached. Serialize replacements so they cannot collide with it.
      await previous;
      await this.closing;
      if (generation !== this.generation) throw new Error("连接已被取消");
      const result = await this.ipc<Attached>("native_bridge_attach", { port, profile });
      if (generation !== this.generation) {
        await this.ipc("native_bridge_detach", { attachment: result.attachment });
        throw new Error("连接已被取消");
      }
      this.attachment = result.attachment;
      this.emit(result.hello);
      void this.pump(result.attachment, generation);
      return result.hello;
    };
    const result = connect();
    this.connecting = result.then(() => undefined, () => undefined);
    return result;
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
    this.monitorOffset = null;
    this.monitorReading = null;
    for (const reject of this.pending) reject(new Error("Bridge 会话已关闭"));
    this.pending.clear();
    const attachment = this.attachment;
    this.attachment = null;
    if (attachment) this.closing = this.closing.then(() => this.ipc("native_bridge_detach", { attachment })).catch(() => undefined);
  }

  configureMonitor(config: NativeMonitorConfig): Promise<void> {
    const attachment = this.attachment, generation = this.generation;
    const result = this.monitorConfiguration.then(async () => {
      if (!attachment || generation !== this.generation) throw new Error("Monitor 会话已改变");
      await this.ipc("native_monitor_configure", { attachment, config });
      if (generation !== this.generation) throw new Error("Monitor 会话已改变");
    });
    this.monitorConfiguration = result.catch(() => undefined);
    return result;
  }

  monitorHistory(after: number): Promise<MonitorHistoryPage> {
    if(this.monitorReading)return this.monitorReading;
    const pending=this.readMonitorHistory(after);
    this.monitorReading=pending;
    void pending.finally(()=>{if(this.monitorReading===pending)this.monitorReading=null;}).catch(()=>{});
    return pending;
  }

  private async readMonitorHistory(after: number): Promise<MonitorHistoryPage> {
    const attachment = this.attachment, generation = this.generation;
    await this.monitorConfiguration;
    if (!attachment || generation !== this.generation) throw new Error("Monitor 会话已改变");
    const started = performance.now();
    const page = await this.ipc<NativeMonitorPage>("native_monitor_history", { attachment, after });
    if (generation !== this.generation || page.epoch !== attachment.epoch) throw new Error("Monitor 历史属于旧会话");
    if (![page.now_ms, page.cursor, page.tail, page.reset, page.lost, page.skipped].every(n => Number.isSafeInteger(n) && n >= 0)
      || page.cursor > page.tail || !Array.isArray(page.rows) || page.rows.length > 256
      || page.rows.some((row,i) => !Number.isSafeInteger(row.received_ms) || row.received_ms < 0 || row.received_ms > page.now_ms
        || !Number.isSafeInteger(row.sequence) || row.sequence <= (i ? page.rows[i-1]!.sequence : after) || row.sequence > page.cursor
        || !Number.isSafeInteger(row.segment) || row.segment < 0 || typeof row.topic !== "string")) throw new Error("Monitor 历史响应无效");
    // Fixed monotonic-domain offset for this attachment. Re-reading a delayed
    // sample must not turn it into a new control/diagnostic observation.
    this.monitorOffset ??= started - page.now_ms;
    return { ...page, localOffset: this.monitorOffset };
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
