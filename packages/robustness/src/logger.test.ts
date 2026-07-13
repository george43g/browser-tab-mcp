import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLogs, getLogs, info, perf, _resetForTests as resetLogger, warn } from "./logger.js";

beforeEach(() => {
  resetLogger();
});

afterEach(() => {
  resetLogger();
});

describe("logger ring buffer", () => {
  it("captures info/warn/error in memoryLines", () => {
    info("test_info");
    warn("test_warn");
    const lines = getLogs();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\[info\] test_info/);
    expect(lines[1]).toMatch(/\[warn\] test_warn/);
  });

  it("clearLogs empties the ring", () => {
    info("a");
    info("b");
    expect(getLogs()).toHaveLength(2);
    clearLogs();
    expect(getLogs()).toHaveLength(0);
  });

  it("getLogs(tail) returns last N lines", () => {
    for (let i = 0; i < 10; i++) info(`msg${i}`);
    expect(getLogs(3)).toHaveLength(3);
    expect(getLogs(3)[2]).toMatch(/msg9/);
  });
});

describe("perf span", () => {
  it("records duration and structured data", async () => {
    const span = perf("test_span");
    await new Promise((r) => setTimeout(r, 5));
    const dur = span.end({ rows: 42 });
    expect(dur).toBeGreaterThan(0);
    const lines = getLogs();
    expect(lines[0]).toMatch(/\[perf\] test_span/);
    expect(lines[0]).toMatch(/"rows":42/);
  });
});
