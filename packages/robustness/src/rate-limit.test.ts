import { describe, expect, it } from "vitest";
import { TokenBucket } from "./rate-limit.js";

describe("TokenBucket", () => {
  it("starts at full capacity", () => {
    const b = new TokenBucket(10, 1);
    expect(b.available()).toBe(10);
  });

  it("deducts tokens on acquire", async () => {
    const b = new TokenBucket(10, 1);
    await b.acquire(3);
    expect(b.available()).toBeCloseTo(7, 0);
  });

  it("refills steadily at rps tokens/sec", () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    b.acquire(10); // drain
    now += 1000; // 1s elapsed -> +5 tokens
    expect(b.available()).toBeCloseTo(5, 0);
    now += 1000;
    expect(b.available()).toBeCloseTo(10, 0); // capped
  });

  it("acquire(0) is a no-op", async () => {
    const b = new TokenBucket(5, 1);
    await b.acquire(0);
    expect(b.available()).toBe(5);
  });

  it("rps=0 disables the limiter (returns immediately)", async () => {
    const b = new TokenBucket(0, 0);
    await b.acquire(100);
    // would hang otherwise — test passes by not timing out
    expect(b.available()).toBe(0);
  });

  it("blocks until refill when starved", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        now += ms;
        resolve();
      });
    const b = new TokenBucket(1, 1, () => now, sleep);
    await b.acquire(1); // immediate
    await b.acquire(1); // must wait ~1s
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1);
  });

  it("rejects negative capacity / rps", () => {
    expect(() => new TokenBucket(-1, 1)).toThrow();
    expect(() => new TokenBucket(1, -1)).toThrow();
  });

  describe("tryAcquire (non-blocking)", () => {
    it("deducts when tokens are available", () => {
      const b = new TokenBucket(2, 2);
      expect(b.tryAcquire(1)).toEqual({ ok: true, retryMs: 0 });
      expect(b.available()).toBeCloseTo(1, 0);
    });

    it("fails fast with a retry estimate when starved (never waits)", () => {
      const now = 0;
      const b = new TokenBucket(2, 2, () => now);
      expect(b.tryAcquire(1).ok).toBe(true);
      expect(b.tryAcquire(1).ok).toBe(true); // drained (2/2)
      const denied = b.tryAcquire(1);
      expect(denied.ok).toBe(false);
      // need 1 token at 2/s → ~500ms
      expect(denied.retryMs).toBeGreaterThanOrEqual(1);
      expect(denied.retryMs).toBeLessThanOrEqual(500);
    });

    it("recovers after enough time elapses", () => {
      let now = 0;
      const b = new TokenBucket(2, 2, () => now);
      b.tryAcquire(1);
      b.tryAcquire(1);
      expect(b.tryAcquire(1).ok).toBe(false);
      now += 1000; // +2 tokens
      expect(b.tryAcquire(1).ok).toBe(true);
    });

    it("tryAcquire(0) always succeeds", () => {
      const b = new TokenBucket(0, 0);
      expect(b.tryAcquire(0)).toEqual({ ok: true, retryMs: 0 });
    });

    it("rps=0 with no tokens reports retryMs 0 (limiter effectively off)", () => {
      const b = new TokenBucket(0, 0);
      expect(b.tryAcquire(1)).toEqual({ ok: false, retryMs: 0 });
    });
  });
});
