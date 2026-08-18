/**
 * The doctor's verdict, and the extension checks that used to bypass it.
 *
 * WHY THIS FILE EXISTS. `doctor` printed its headline FIRST and then appended
 * extension warnings underneath, so a stale extension produced
 * "Doctor: all clear." followed by two ⚠ lines. Worse, `ok` was
 * `every(i => i.status !== "error")`, so a warning never reached the headline
 * at all — and the extension checks lived inline in the CLI action, the only
 * checks in the file with no test.
 */

import { describe, expect, it } from "vitest";
import {
  type AccessCheckItem,
  buildReport,
  extensionCheckItems,
  formatAccessReport,
  headlineFor,
} from "./access-check.js";

const item = (status: AccessCheckItem["status"], key: string = status): AccessCheckItem => ({
  key,
  label: key,
  status,
  detail: "detail",
});

describe("doctor verdict", () => {
  it("says all clear only when nothing needs attention", () => {
    expect(headlineFor(buildReport([item("ok"), item("info")]))).toBe("Doctor: all clear.");
  });

  it("names warnings instead of claiming all clear", () => {
    // The bug: this used to read "Doctor: all clear." with a ⚠ row underneath.
    const report = buildReport([item("ok"), item("warn")]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toBe(1);
    expect(headlineFor(report)).toBe("Doctor: 1 warning — see below.");
  });

  it("pluralises, because the headline is read on its own", () => {
    expect(headlineFor(buildReport([item("warn", "a"), item("warn", "b")]))).toBe(
      "Doctor: 2 warnings — see below.",
    );
  });

  it("an error outranks a warning", () => {
    const report = buildReport([item("warn"), item("error")]);
    expect(report.ok).toBe(false);
    expect(headlineFor(report)).toBe("Doctor: issues found.");
  });

  it("puts the headline above the items it summarises", () => {
    const out = formatAccessReport(buildReport([item("warn")])).split("\n");
    expect(out[0]).toContain("1 warning");
    expect(out[1]).toContain("⚠");
  });
});

describe("extension checks", () => {
  const cmpSame = () => ({ kind: "same" });
  const cmpMismatch = () => ({ kind: "mismatch" });
  const cmpUnstamped = () => ({ kind: "unstamped" });

  it("is silent when nothing is connected", () => {
    expect(extensionCheckItems([], null, 2, cmpSame)).toEqual([]);
  });

  it("warns on a stale protocol, and that warning reaches the verdict", () => {
    const items = extensionCheckItems(
      [{ browser: "chrome", protocolVersion: 1, stale: true }],
      null,
      2,
      cmpSame,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("warn");
    // The whole point: folding these in means the headline can no longer lie.
    expect(headlineFor(buildReport(items))).toContain("1 warning");
  });

  it("reports the daemon build as info, not a warning", () => {
    const items = extensionCheckItems([], "1.2.1+57.abc", 2, cmpSame);
    expect(items.map((i) => i.status)).toEqual(["info"]);
    expect(items[0]?.detail).toBe("1.2.1+57.abc");
  });

  it("warns when a build differs — a rebuilt extension is not a reloaded one", () => {
    const items = extensionCheckItems(
      [{ browser: "safari", protocolVersion: 2, stale: false, extVersion: "1.2.0+50.old" }],
      "1.2.1+57.new",
      2,
      cmpMismatch,
    );
    const warn = items.find((i) => i.status === "warn");
    expect(warn?.key).toBe("ext-build-safari");
    expect(warn?.detail).toContain("1.2.0+50.old");
  });

  it("warns when an extension predates build stamping", () => {
    const items = extensionCheckItems(
      [{ browser: "chrome", protocolVersion: 2, stale: false, extVersion: "0.2.0" }],
      "1.2.1+57.new",
      2,
      cmpUnstamped,
    );
    expect(items.find((i) => i.status === "warn")?.detail).toContain("no build stamp");
  });

  it("skips the build comparison entirely when the daemon is down", () => {
    // No daemon build means no basis for comparison — silence beats a guess.
    const items = extensionCheckItems(
      [{ browser: "chrome", protocolVersion: 2, stale: false, extVersion: "0.2.0" }],
      null,
      2,
      cmpUnstamped,
    );
    expect(items).toEqual([]);
  });
});
