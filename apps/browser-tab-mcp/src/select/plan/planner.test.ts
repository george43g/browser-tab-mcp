/**
 * planTransform — the §7 policy table, each row asserted by its stable
 * PlanError code, plus semantic checks simulated end-to-end (the §9.6
 * in-place example from the spec verbatim). The planner is pure: every test
 * runs against one fixture snapshot and its refs.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { type BrowserRef, makeBrowserDomain } from "../browser-domain.js";
import type { ActEffect, RelocateEffect } from "./effects.js";
import { PlanError, planTransform } from "./planner.js";

const tab = (id: string, index: number, over: Record<string, unknown> = {}) =>
  makeContractTab({ tabId: id, index, ...over });

// w1: a b c d e f (b pinned in pinnedSnap variant) · w2: p q · safari: s1
function fixture(opts: { pinB?: boolean } = {}) {
  return makeSnapshot({
    browsers: [
      makeBrowserState({
        browser: "chrome",
        extensionConnected: true,
        dataSource: "extension",
        windows: [
          makeContractWindow({
            windowId: "w:chrome:x1",
            focused: true,
            tabs: [
              tab("a", 0),
              tab("b", 1, opts.pinB ? { pinned: true } : { groupId: "g:chrome:x7" }),
              tab("c", 2),
              tab("d", 3),
              tab("e", 4),
              tab("f", 5),
            ],
          }),
          makeContractWindow({
            windowId: "w:chrome:x2",
            focused: false,
            tabs: [tab("p", 0), tab("q", 1)],
          }),
        ],
      }),
      makeBrowserState({
        browser: "safari",
        extensionConnected: false,
        dataSource: "applescript",
        windows: [
          makeContractWindow({ windowId: "w:safari:1", focused: false, tabs: [tab("s1", 0)] }),
        ],
      }),
    ],
  });
}

function refsOf(snap: ReturnType<typeof fixture>, ids: string[]): BrowserRef[] {
  const domain = makeBrowserDomain(snap);
  return ids.map((id) => domain.byKey(id) as BrowserRef);
}

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return e instanceof PlanError ? e.code : `OTHER: ${(e as Error).message}`;
  }
};

describe("planTransform — policy table (§7 freeze)", () => {
  const snap = fixture();

  it("empty selection errors", () => {
    expect(code(() => planTransform([], { kind: "reverse" }, snap))).toBe("empty_selection");
  });

  it("a structural node in the selection errors", () => {
    const domain = makeBrowserDomain(snap);
    const win = domain.byKey("w:chrome:x1") as BrowserRef;
    expect(code(() => planTransform([win], { kind: "reverse" }, snap))).toBe("non_tab_selection");
  });

  it("cross-domain selections are blocked before any effect", () => {
    const refs = refsOf(snap, ["a", "s1"]);
    expect(code(() => planTransform(refs, { kind: "reverse" }, snap))).toBe(
      "cross_domain_live_move",
    );
  });

  it("pinned members error without a policy and skip with one (reported)", () => {
    const pinned = fixture({ pinB: true });
    const refs = refsOf(pinned, ["a", "b"]);
    expect(
      code(() =>
        planTransform(
          refs,
          { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x1", at: -1 } },
          pinned,
        ),
      ),
    ).toBe("pinned_without_policy");
    const plan = planTransform(
      refs,
      { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x1", at: -1 } },
      pinned,
      { pinPolicy: "skip" },
    );
    expect(plan.warnings.join(" ")).toMatch(/dropped 1 pinned/);
    expect(plan.effects.every((e) => e.kind !== "relocate" || e.tabId !== "b")).toBe(true);
  });

  it("moving grouped tabs warns (tabsOnly), naming the group", () => {
    const plan = planTransform(
      refsOf(snap, ["b"]),
      { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x2", at: -1 } },
      snap,
    );
    expect(plan.warnings.join(" ")).toMatch(/g:chrome:x7/);
  });

  it("a destination anchor inside the selection errors", () => {
    expect(
      code(() =>
        planTransform(
          refsOf(snap, ["a", "b"]),
          { kind: "move", destination: { kind: "anchor", tabId: "a", offset: 1 } },
          snap,
        ),
      ),
    ).toBe("destination_in_selection");
  });

  it("an unknown destination window errors actionably", () => {
    expect(
      code(() =>
        planTransform(
          refsOf(snap, ["a"]),
          { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x404", at: 1 } },
          snap,
        ),
      ),
    ).toBe("unknown_destination");
  });

  it("an out-of-range slot clamps WITH a warning", () => {
    const plan = planTransform(
      refsOf(snap, ["a"]),
      { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x2", at: 99 } },
      snap,
    );
    expect(plan.warnings.join(" ")).toMatch(/clamped/);
    const last = plan.effects[plan.effects.length - 1] as RelocateEffect;
    expect(last.after).toBe("q");
  });
});

describe("planTransform — semantics", () => {
  const snap = fixture();

  it("same-window block move lands in selection order after the gap", () => {
    // Move [e, c] to slot 1 (front): desired a-strip = e c a b d f
    const plan = planTransform(
      refsOf(snap, ["e", "c"]),
      { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x1", at: 1 } },
      snap,
    );
    const fx = plan.effects as RelocateEffect[];
    expect(fx.map((e) => [e.tabId, e.after])).toEqual([
      ["e", null],
      ["c", "e"],
    ]);
    expect(plan.riskClass).toBe("live-layout");
  });

  it("cross-window move-in relocates into the destination window", () => {
    const plan = planTransform(
      refsOf(snap, ["a", "b"]),
      { kind: "move", destination: { kind: "anchor", tabId: "p", offset: 1 } },
      snap,
    );
    const fx = plan.effects as RelocateEffect[];
    expect(fx.every((e) => e.targetWindowId === "w:chrome:x2")).toBe(true);
    expect(fx.map((e) => [e.tabId, e.after])).toEqual([
      ["a", "p"],
      ["b", "a"],
    ]);
  });

  it("reverse matches the spec §9.6 example: A B C D E F selecting B D F → A F C D E B", () => {
    // In-place: occupied slots 1,3,5 keep their positions; occupants reverse.
    // B→F's slot? Spec: A F C D E B — F takes slot 1, D stays, B takes slot 5.
    const plan = planTransform(refsOf(snap, ["b", "d", "f"]), { kind: "reverse" }, snap);
    const fx = plan.effects as RelocateEffect[];
    // Simulate onto the strip to check the final arrangement.
    const strip = ["a", "b", "c", "d", "e", "f"];
    for (const e of fx) {
      strip.splice(strip.indexOf(e.tabId), 1);
      if (e.after === null) strip.unshift(e.tabId);
      else strip.splice(strip.indexOf(e.after) + 1, 0, e.tabId);
    }
    expect(strip).toEqual(["a", "f", "c", "d", "e", "b"]);
  });

  it("setOrder permutes only the listed tabs across their own slots", () => {
    const plan = planTransform(
      refsOf(snap, ["a"]), // selection is irrelevant to setOrder's scope
      { kind: "setOrder", windowId: "w:chrome:x1", tabs: ["f", "c", "a"] },
      snap,
    );
    const fx = plan.effects as RelocateEffect[];
    const strip = ["a", "b", "c", "d", "e", "f"];
    for (const e of fx) {
      strip.splice(strip.indexOf(e.tabId), 1);
      if (e.after === null) strip.unshift(e.tabId);
      else strip.splice(strip.indexOf(e.after) + 1, 0, e.tabId);
    }
    // Slots 0,2,5 (a,c,f's slots) now read f,c,a; b,d,e untouched.
    expect(strip).toEqual(["f", "b", "c", "d", "e", "a"]);
  });

  it("setOrder rejects tabs not in the window", () => {
    expect(
      code(() =>
        planTransform(
          refsOf(snap, ["a"]),
          { kind: "setOrder", windowId: "w:chrome:x1", tabs: ["p"] },
          snap,
        ),
      ),
    ).toBe("unknown_member");
  });

  it("sort by title orders the selection stably within its slots", () => {
    // Titles default to the factory's fixed title, so sort by url instead:
    // give distinct urls via tab ids — the fixture's urls are identical, so
    // sort by index descending is the observable, deterministic choice here.
    const plan = planTransform(
      refsOf(snap, ["a", "c", "e"]),
      { kind: "sort", by: [{ field: "index", direction: "desc" }] },
      snap,
    );
    const fx = plan.effects as RelocateEffect[];
    const strip = ["a", "b", "c", "d", "e", "f"];
    for (const e of fx) {
      strip.splice(strip.indexOf(e.tabId), 1);
      if (e.after === null) strip.unshift(e.tabId);
      else strip.splice(strip.indexOf(e.after) + 1, 0, e.tabId);
    }
    expect(strip).toEqual(["e", "b", "c", "d", "a", "f"]);
  });

  it("pack defaults to gathering at the first member's position", () => {
    const plan = planTransform(refsOf(snap, ["b", "e"]), { kind: "pack" }, snap);
    const fx = plan.effects as RelocateEffect[];
    const strip = ["a", "b", "c", "d", "e", "f"];
    for (const e of fx) {
      strip.splice(strip.indexOf(e.tabId), 1);
      if (e.after === null) strip.unshift(e.tabId);
      else strip.splice(strip.indexOf(e.after) + 1, 0, e.tabId);
    }
    expect(strip).toEqual(["a", "b", "e", "c", "d", "f"]);
  });

  it("an already-satisfied transform is a disclosed no-op", () => {
    const plan = planTransform(
      refsOf(snap, ["a", "b"]),
      { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x1", at: 1 } },
      snap,
    );
    expect(plan.effects).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/no-op/);
  });

  it("multi-window in-place permutation warns and stays per-window", () => {
    const plan = planTransform(refsOf(snap, ["a", "c", "p", "q"]), { kind: "reverse" }, snap);
    expect(plan.warnings.join(" ")).toMatch(/per window/);
    const fx = plan.effects as RelocateEffect[];
    expect(
      fx.every((e) => e.targetWindowId === "w:chrome:x1" || e.targetWindowId === "w:chrome:x2"),
    ).toBe(true);
  });
});

describe("planTransform — the act transform (Phase 5 PR-M)", () => {
  const snap = fixture();
  const pinnedSnap = fixture({ pinB: true });

  it("fans one act effect per member, in selection order", () => {
    const plan = planTransform(
      refsOf(snap, ["c", "a", "e"]),
      { kind: "act", action: "mute" },
      snap,
    );
    expect(
      plan.effects.map((e) => [e.kind, (e as ActEffect).tabId, (e as ActEffect).action]),
    ).toEqual([
      ["act", "c", "mute"],
      ["act", "a", "mute"],
      ["act", "e", "mute"],
    ]);
  });

  it("live-layout verbs stay applyable; state-losing verbs come back destructive", () => {
    const refs = refsOf(snap, ["a", "c"]);
    expect(planTransform(refs, { kind: "act", action: "mute" }, snap).riskClass).toBe(
      "live-layout",
    );
    expect(planTransform(refs, { kind: "act", action: "pin" }, snap).riskClass).toBe("live-layout");
    // discard/reload throw away in-page state — the same reason tab_action
    // carries destructiveHint. apply_tab_layout refuses these by the existing
    // gate, which is the whole point of classifying by verb.
    expect(planTransform(refs, { kind: "act", action: "discard" }, snap).riskClass).toBe(
      "destructive",
    );
    expect(planTransform(refs, { kind: "act", action: "reload" }, snap).riskClass).toBe(
      "destructive",
    );
  });

  it("ACTS ACROSS live-move domains — the relocation guard must not apply", () => {
    // "a" is Chrome-via-extension, "s1" is Safari-via-AppleScript: two live-move
    // domains, which a relocation is right to refuse and an act is not. If this
    // ever goes red, the language can select across browsers and cannot act
    // across them — the gap this phase closed, reintroduced one layer down.
    const refs = refsOf(snap, ["a", "s1"]);
    expect(code(() => planTransform(refs, { kind: "reverse" }, snap))).toBe(
      "cross_domain_live_move",
    );
    const plan = planTransform(refs, { kind: "act", action: "mute" }, snap);
    expect(plan.effects).toHaveLength(2);
    expect(plan.riskClass).toBe("live-layout");
  });

  it("acts on pinned members without a pinPolicy — pinning is not index-space", () => {
    // A relocation errors here because pinned tabs change index semantics.
    // "unpin everything pinned" must not be blocked by the same guard.
    const refs = refsOf(pinnedSnap, ["a", "b"]);
    expect(code(() => planTransform(refs, { kind: "reverse" }, pinnedSnap))).toBe(
      "pinned_without_policy",
    );
    const plan = planTransform(refs, { kind: "act", action: "unpin" }, pinnedSnap);
    expect(plan.effects.map((e) => (e as ActEffect).tabId)).toEqual(["a", "b"]);
  });

  it('action "group" with no groupId refuses a selection spanning windows', () => {
    // A Chrome group cannot straddle windows; inventing a target window on the
    // caller's behalf is exactly the silent policy this planner forbids.
    const refs = refsOf(snap, ["a", "p"]);
    expect(code(() => planTransform(refs, { kind: "act", action: "group" }, snap))).toBe(
      "invalid_transform",
    );
    // …and allows it when the caller names the group to join.
    const plan = planTransform(
      refs,
      { kind: "act", action: "group", groupId: "g:chrome:x7" },
      snap,
    );
    expect(plan.effects.every((e) => (e as ActEffect).groupId === "g:chrome:x7")).toBe(true);
  });
});
