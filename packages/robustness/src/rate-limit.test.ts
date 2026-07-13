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
});
