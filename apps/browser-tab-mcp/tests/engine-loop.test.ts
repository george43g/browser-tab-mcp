/**
 * pollMs / extFeedTtlMs — the extension-feed TTL floor.
 *
 * A fast poll must NOT collapse the freshness window below 60s. The
 * idle-decay bug (fixed 2026-07-20): a 5s poll once let an idle-but-connected
 * browser revert to AppleScript handles after ~10s, silently routing `move`
 * down the state-losing close+reopen path. `extFeedTtlMs = max(pollMs*2, 60s)`
 * is the guard.
 *
 * Sabotage guard: drop the `Math.max(..., 60_000)` floor → the fast-poll
 * cases redden.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { extFeedTtlMs, pollMs } from "../src/daemon/engine-loop.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pollMs", () => {
  it("defaults to 5000ms when unset", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "");
    expect(pollMs()).toBe(5_000);
  });

  it("honors BROWSER_TAB_POLL_MS", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "8000");
    expect(pollMs()).toBe(8_000);
  });

  it("falls back to the default for a non-numeric value", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "not-a-number");
    expect(pollMs()).toBe(5_000);
  });
});

describe("extFeedTtlMs floor", () => {
  it("floors at 60s for the default 5s poll: max(10s, 60s)", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "5000");
    expect(extFeedTtlMs()).toBe(60_000);
  });

  it("stays at 60s even for a very fast 1s poll (the idle-decay guard): max(2s, 60s)", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "1000");
    expect(extFeedTtlMs()).toBe(60_000);
  });

  it("uses 2× the poll interval once that exceeds the 60s floor: max(80s, 60s)", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "40000");
    expect(extFeedTtlMs()).toBe(80_000);
  });

  it("never drops below 60s for any tiny poll", () => {
    vi.stubEnv("BROWSER_TAB_POLL_MS", "100");
    expect(extFeedTtlMs()).toBeGreaterThanOrEqual(60_000);
  });
});
