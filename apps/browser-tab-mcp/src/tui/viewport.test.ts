/**
 * Viewport arithmetic — the two defects this replaced were both measured live
 * in a tmux pane, so the numbers below are the real observed ones.
 */

import { describe, expect, it } from "vitest";
import { CHROME_ROWS, viewportRows, visibleWindow } from "./viewport.js";

describe("viewportRows", () => {
  it("fills the terminal instead of a hardcoded 24", () => {
    // Measured: a 50-row terminal rendered 24 rows and left 22 blank.
    expect(viewportRows(50)).toBe(50 - CHROME_ROWS);
    expect(viewportRows(50)).toBeGreaterThan(24);
  });

  it("shrinks below 24 so a short terminal cannot overflow the chrome", () => {
    // Measured: at 20 rows the fixed 24 overprinted rows and destroyed the
    // status bar. The list must ask for less than the terminal has.
    expect(viewportRows(20)).toBe(16);
    expect(viewportRows(20) + CHROME_ROWS).toBeLessThanOrEqual(20);
  });

  it("never goes below one row, even for absurd sizes", () => {
    for (const rows of [4, 3, 1, 0, -5]) {
      expect(viewportRows(rows)).toBeGreaterThanOrEqual(1);
    }
  });

  it("survives a non-finite row count", () => {
    expect(viewportRows(Number.NaN)).toBe(1);
  });
});

describe("visibleWindow", () => {
  it("centres the cursor in the middle of a long list", () => {
    expect(visibleWindow(50, 100, 20)).toEqual({ start: 40, end: 60 });
  });

  it("pins to the top without scrolling past the start", () => {
    expect(visibleWindow(0, 100, 20)).toEqual({ start: 0, end: 20 });
    expect(visibleWindow(3, 100, 20)).toEqual({ start: 0, end: 20 });
  });

  it("stays FULL at the end of the list", () => {
    // Regression: unclamped, cursor 33 of 34 with viewport 24 gave
    // start = 33 - 12 = 21 → only 13 rows rendered, 33 blank.
    expect(visibleWindow(33, 34, 24)).toEqual({ start: 10, end: 34 });
    expect(visibleWindow(33, 34, 24).end - visibleWindow(33, 34, 24).start).toBe(24);
  });

  it("renders every row when the list is shorter than the viewport", () => {
    expect(visibleWindow(2, 5, 40)).toEqual({ start: 0, end: 5 });
  });

  it("is always exactly min(viewport, total) tall for every cursor position", () => {
    const total = 34;
    const viewport = 24;
    for (let cursor = 0; cursor < total; cursor++) {
      const { start, end } = visibleWindow(cursor, total, viewport);
      expect(end - start, `cursor ${cursor}`).toBe(Math.min(viewport, total));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(total);
      // the cursor must remain inside the window it is meant to centre
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
    }
  });

  it("handles an empty list", () => {
    expect(visibleWindow(0, 0, 20)).toEqual({ start: 0, end: 0 });
  });
});
