import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatHealthText, snapshotHealth } from "./health.js";
import { _resetForTests as resetWatchdog } from "./watchdog.js";

beforeEach(() => {
  resetWatchdog();
});

afterEach(() => {
  resetWatchdog();
});

describe("snapshotHealth", () => {
  it("reports healthy with zero counters and quiet watchdog", () => {
    const snap = snapshotHealth({ toolCalls: 0, recentErrors: 0 });
    expect(snap.status).toBe("healthy");
    expect(snap.issues).toEqual([]);
    expect(snap.pid).toBe(process.pid);
    expect(snap.node).toBe(process.version);
  });

  it("flags degraded on 5+ recent errors", () => {
    const snap = snapshotHealth({ toolCalls: 10, recentErrors: 5 });
    expect(snap.status).toBe("degraded");
    expect(snap.issues[0]).toMatch(/5 recent errors/);
  });

  it("returns numeric memory + event-loop fields", () => {
    const snap = snapshotHealth({ toolCalls: 0, recentErrors: 0 });
    expect(typeof snap.heap_mb).toBe("number");
    expect(typeof snap.rss_mb).toBe("number");
    expect(typeof snap.event_loop_p99_ms).toBe("number");
  });
});

describe("formatHealthText", () => {
  it("produces multi-line text starting with Status:", () => {
    const snap = snapshotHealth({ toolCalls: 7, recentErrors: 0 });
    const text = formatHealthText(snap);
    expect(text.startsWith("Status: healthy")).toBe(true);
    expect(text).toMatch(/PID: \d+/);
    expect(text).toMatch(/Node: v/);
    expect(text).toMatch(/Tool calls: 7/);
  });

  it("includes Issues line when issues present", () => {
    const snap = snapshotHealth({ toolCalls: 0, recentErrors: 6 });
    const text = formatHealthText(snap);
    expect(text).toMatch(/Issues:/);
  });

  it("omits Issues line when healthy", () => {
    const snap = snapshotHealth({ toolCalls: 0, recentErrors: 0 });
    const text = formatHealthText(snap);
    expect(text).not.toMatch(/^Issues:/m);
  });
});
