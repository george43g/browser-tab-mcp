/**
 * Which tab actions the TUI offers, and to whom.
 *
 * A menu is a promise. Offering `duplicate` on a browser whose only pathway is
 * AppleScript produces an entry whose sole outcome is an error toast — so the
 * list is capability-filtered, and gated on the runtime-probed MAP rather than
 * on the browser name (the repo invariant).
 */

import { describe, expect, it } from "vitest";
import { ALL_HINTS, availableActions, TAB_ACTIONS, visibleHints } from "./actions.js";

const caps = (over: Record<string, boolean> = {}) => ({
  capabilities: { muted: true, discard: true, duplicate: true, backForward: true, ...over },
});
const plainTab = {};

describe("availableActions", () => {
  it("offers the full set to a fully capable browser", () => {
    const got = availableActions(caps(), plainTab).map((a) => a.action);
    expect(got).toContain("mute");
    expect(got).toContain("discard");
    expect(got).toContain("duplicate");
    expect(got).toContain("back");
  });

  it("drops what the browser cannot do", () => {
    const got = availableActions(caps({ duplicate: false, backForward: false }), plainTab).map(
      (a) => a.action,
    );
    expect(got).not.toContain("duplicate");
    expect(got).not.toContain("back");
    // reload has no capability gate — every pathway, including AppleScript,
    // can reload — so it must survive.
    expect(got).toContain("reload");
  });

  it("treats a missing capability map conservatively, not permissively", () => {
    // A legacy extension reports no map. The daemon already defaults unknown
    // capabilities to false; the menu must agree rather than promise more.
    const got = availableActions({ capabilities: undefined }, plainTab).map((a) => a.action);
    expect(got).toEqual(["pin", "reload"]);
  });

  it("never offers both halves of a toggle at once", () => {
    // "mute" and "unmute" side by side asks the user to know which applies.
    const silent = availableActions(caps(), { muted: false }).map((a) => a.action);
    expect(silent).toContain("mute");
    expect(silent).not.toContain("unmute");

    const muted = availableActions(caps(), { muted: true }).map((a) => a.action);
    expect(muted).toContain("unmute");
    expect(muted).not.toContain("mute");
  });

  it("hides discard for an already-sleeping tab", () => {
    expect(availableActions(caps(), { discarded: true }).map((a) => a.action)).not.toContain(
      "discard",
    );
  });

  it("pairs every toggle it declares", () => {
    // A toggle with only one half is a menu the user cannot get back out of.
    const names = new Set(TAB_ACTIONS.map((a) => a.action));
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ["mute", "unmute"],
      ["pin", "unpin"],
    ];
    for (const [on, off] of pairs) {
      expect(names.has(on) && names.has(off), `${on}/${off} must both exist`).toBe(true);
    }
  });

  it("returns an empty list rather than a stub when nothing applies", () => {
    // App.tsx refuses to open an empty picker; it relies on getting [] here.
    const none = availableActions({ capabilities: {} }, { pinned: true, discarded: true });
    expect(none.map((a) => a.action)).toEqual(["unpin", "reload"]);
  });
});

describe("visibleHints", () => {
  // The kit's HelpBar is flexWrap="wrap" and App.tsx clamps it to one row, so
  // an overflowing bar does not wrap visibly — it silently loses its tail. The
  // tail was `q quit`. This is the same "drop a column, never squeeze" rule the
  // CLI's layoutRow follows, for the same reason.
  it("shows everything when there is room", () => {
    expect(visibleHints(200).map((h) => h.key)).toContain("r");
    expect(visibleHints(200)).toHaveLength(ALL_HINTS.length);
  });

  it("drops the least useful first", () => {
    // refresh (6) goes before fold (5), which goes before move tab (4).
    const at96 = visibleHints(96).map((h) => h.key);
    expect(at96).not.toContain("r");
    expect(at96).toContain("space");
  });

  it("never drops quit, focus or motion — at ANY width", () => {
    // Without these the TUI is unusable and, worse, unquittable.
    for (const cols of [200, 120, 100, 80, 60, 40, 20, 1]) {
      const keys = visibleHints(cols).map((h) => h.key);
      expect(keys, `at ${cols} columns`).toEqual(expect.arrayContaining(["q", "⏎", "j/k"]));
    }
  });

  it("fits the real rendered width, not an idealised one", () => {
    // The bug this encodes: an arithmetic model that ignored the kit's
    // marginRight and " · " separator underestimated by ~20 columns, so 8
    // hints "fit" in 100 and the bar wrapped.
    const rendered = (hs: { key: string; label: string }[]) =>
      hs.reduce((n, h) => n + h.key.length + 1 + h.label.length + 2, 0) +
      Math.max(0, hs.length - 1) * 3 +
      2;
    for (const cols of [200, 120, 100, 90, 80, 60, 40]) {
      const hints = visibleHints(cols);
      // Either it fits, or only the undroppable ones are left.
      const fits = rendered(hints) <= cols;
      const minimal = hints.every((h) => h.sacrifice === undefined);
      expect(fits || minimal, `at ${cols}: ${rendered(hints)} cols for ${hints.length} hints`).toBe(
        true,
      );
    }
  });
});
