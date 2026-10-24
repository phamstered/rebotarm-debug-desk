import { describe, expect, it, vi } from "vitest";
import { SessionResourceCache } from "./resourceCacheLogic";
const bytes = (size = 2) => ({ bytes: new Uint8Array(size), mime: "model/stl" });

describe("session resource cache", () => {
  it("coalesces simultaneous loads and reuses bytes on warm returns", async () => {
    const cache = new SessionResourceCache();
    const load = vi.fn().mockResolvedValue(bytes());
    const [a, b] = await Promise.all([cache.get("a", load), cache.get("a", load)]);
    expect(a).toBe(b);
    expect(await cache.get("a", load)).toBe(a);
    expect(load).toHaveBeenCalledOnce();
  });
  it("cancels one consumer without cancelling another, aborts the last consumer and retries", async () => {
    const cache = new SessionResourceCache();
    let finish!: (value: ReturnType<typeof bytes>) => void;
    const load = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const a = new AbortController(), b = new AbortController();
    const first = cache.get("a", load, a.signal), second = cache.get("a", load, b.signal);
    a.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(load.mock.calls[0][0].aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(load.mock.calls[0][0].aborted).toBe(true);
    finish(bytes());
    await expect(cache.get("a", async () => bytes(3))).resolves.toMatchObject({ bytes: new Uint8Array(3) });
  });
  it("clears in-flight and completed data on disconnect even if the loader ignores abort", async () => {
    const cache = new SessionResourceCache();
    await cache.get("cached", async () => bytes());
    const old = cache.get("pending", () => new Promise(() => {}));
    cache.clear();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    const load = vi.fn().mockResolvedValue(bytes());
    await cache.get("cached", load);
    expect(load).toHaveBeenCalledOnce();
  });
  it("uses bounded LRU storage and never caches errors or oversized results", async () => {
    const cache = new SessionResourceCache(4);
    const load = vi.fn().mockResolvedValue(bytes());
    await cache.get("a", load); await cache.get("b", load); await cache.get("a", load); await cache.get("c", load);
    await cache.get("b", load);
    expect(load).toHaveBeenCalledTimes(4);
    await expect(cache.get("bad", async () => { throw Error("missing"); })).rejects.toThrow("missing");
    await cache.get("bad", load);
    const big = vi.fn().mockResolvedValue(bytes(5));
    await cache.get("big", big); await cache.get("big", big);
    expect(big).toHaveBeenCalledTimes(2);
    const aborted = new AbortController(); aborted.abort();
    await expect(cache.get("a", load, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
