import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isShuttingDown,
  registerCleanup,
  _resetForTests as resetShutdown,
  unregisterCleanup,
} from "./shutdown.js";

beforeEach(() => {
  resetShutdown();
});

afterEach(() => {
  resetShutdown();
});

describe("registerCleanup / unregisterCleanup", () => {
  it("is not shutting down before shutdown() is called", () => {
    expect(isShuttingDown()).toBe(false);
  });

  it("registers and unregisters cleanup functions", () => {
    const fn = vi.fn();
    registerCleanup(fn);
    // No assertion on internal state — just ensure no throw.
    unregisterCleanup(fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
