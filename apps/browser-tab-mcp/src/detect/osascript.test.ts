/**
 * Retry policy for READ-ONLY AppleScript.
 *
 * The whole safety argument for retrying at all is that only reads are
 * idempotent — `runOsa` also carries focus/close/move, and replaying one of
 * those would act twice. These tests pin the predicate that decides what is
 * worth a second attempt.
 */

import { describe, expect, it } from "vitest";
import { OsaPermissionError, OsaTimeoutError, shouldRetryOsaRead } from "./osascript.js";

describe("shouldRetryOsaRead", () => {
  it("retries the generic osascript failure (browser mid-launch / mid-quit)", () => {
    // AppleEvent -600 "Application isn't running" and friends arrive as a plain
    // Error and currently poison an otherwise fine snapshot.
    expect(shouldRetryOsaRead(new Error('osascript failed for "Google Chrome": -600'))).toBe(true);
  });

  it("does NOT retry a permission error — it is permanent until the user acts", () => {
    // Retrying only delays an actionable "grant Automation permission" message.
    expect(shouldRetryOsaRead(new OsaPermissionError("Google Chrome"))).toBe(false);
  });

  it("does NOT retry a timeout — it already burned the full budget", () => {
    // The first-contact case allows 60s; stacking those would wedge the poll loop.
    expect(shouldRetryOsaRead(new OsaTimeoutError("Safari", 5_000))).toBe(false);
  });
});
