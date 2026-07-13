import { describe, expect, it, vi } from "vitest";
import { isTransientError, withRetry } from "./retry.js";

describe("isTransientError", () => {
  it("flags ETIMEDOUT", () => {
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("flags 429", () => {
    expect(isTransientError({ status: 429 })).toBe(true);
  });

  it("flags 5xx", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(isTransientError({ status })).toBe(true);
    }
  });

  it("flags response.status 5xx", () => {
    expect(isTransientError({ response: { status: 502 } })).toBe(true);
  });

  it("does not flag 4xx (except 429)", () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  it("does not flag null/undefined/primitives", () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError("oops")).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { maxAttempts: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors up to maxAttempts", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce("recovered");
    const timer = vi.fn((cb: () => void) => cb());
    const result = await withRetry(fn, { maxAttempts: 3, baseMs: 1, jitter: false, timer });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    const timer = vi.fn((cb: () => void) => cb());
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1, timer })).rejects.toMatchObject({
      status: 400,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom shouldRetry predicate", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("retry me")).mockResolvedValueOnce("ok");
    const timer = vi.fn((cb: () => void) => cb());
    const result = await withRetry(fn, {
      maxAttempts: 2,
      baseMs: 1,
      shouldRetry: (e) => (e as Error).message === "retry me",
      timer,
    });
    expect(result).toBe("ok");
  });

  it("throws last error when retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500, message: "fifth" });
    const timer = vi.fn((cb: () => void) => cb());
    await expect(withRetry(fn, { maxAttempts: 3, baseMs: 1, timer })).rejects.toMatchObject({
      status: 500,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
