export type ResourceBytes = { bytes: Uint8Array; mime: string };
export function loadAborted(): DOMException { return new DOMException("资源加载已取消", "AbortError"); }

type Job = { controller: AbortController; promise: Promise<ResourceBytes>; users: number };

/** A connection owns its bytes; temporary scene URLs are owned by the scene. */
export class SessionResourceCache {
  private values = new Map<string, ResourceBytes>();
  private jobs = new Map<string, Job>();
  private size = 0;
  constructor(private readonly budget = 128 * 1024 * 1024) {}

  clear() {
    this.values.clear(); this.size = 0;
    this.jobs.forEach((job) => job.controller.abort());
    this.jobs.clear();
  }

  async get(uri: string, load: (signal: AbortSignal) => Promise<ResourceBytes>, signal?: AbortSignal): Promise<ResourceBytes> {
    if (signal?.aborted) throw loadAborted();
    const cached = this.values.get(uri);
    if (cached) {
      this.values.delete(uri); this.values.set(uri, cached);
      return cached;
    }
    let job = this.jobs.get(uri);
    if (!job) {
      const controller = new AbortController();
      const created: Job = { controller, users: 0, promise: Promise.resolve().then(() => { if (controller.signal.aborted) throw loadAborted(); return load(controller.signal); }) };
      created.promise = created.promise.then((value) => {
        if (controller.signal.aborted) throw loadAborted();
        if (value.bytes.byteLength <= this.budget) {
          while (this.size + value.bytes.byteLength > this.budget && this.values.size) {
            const oldest = this.values.keys().next().value!;
            this.size -= this.values.get(oldest)!.bytes.byteLength;
            this.values.delete(oldest);
          }
          this.values.set(uri, value); this.size += value.bytes.byteLength;
        }
        return value;
      }).finally(() => { if (this.jobs.get(uri) === created) this.jobs.delete(uri); });
      this.jobs.set(uri, created); job = created;
    }
    const shared = job;
    shared.users += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: unknown, value?: ResourceBytes) => {
        if (finished) return;
        finished = true; signal?.removeEventListener("abort", abort); shared.controller.signal.removeEventListener("abort", abort);
        shared.users -= 1;
        if (!shared.users && this.jobs.get(uri) === shared) {
          this.jobs.delete(uri); shared.controller.abort();
        }
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(loadAborted());
      signal?.addEventListener("abort", abort, { once: true });
      shared.controller.signal.addEventListener("abort", abort, { once: true });
      shared.promise.then((value) => finish(undefined, value), (error) => finish(error));
    });
  }
}
