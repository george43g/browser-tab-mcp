/**
 * planTabChange orchestration — both selection paths share one snapshot and
 * one planner; staleness is a refusal, never a silent re-resolve.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import type { JournalStore } from "./journal.js";
import { planTabChange } from "./plan-change.js";
import { PlanStore } from "./plans.js";
import { selectTabs } from "./select.js";
import { SelectionStore } from "./selections.js";
import { StateStore } from "./state.js";

function deps() {
  const store = new StateStore();
  store.update(
    makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: true,
          dataSource: "extension",
          windows: [
            makeContractWindow({
              windowId: "w:chrome:x1",
              tabs: [
                makeContractTab({ tabId: "a", index: 0 }),
                makeContractTab({ tabId: "b", index: 1 }),
                makeContractTab({ tabId: "c", index: 2 }),
              ],
            }),
          ],
        }),
      ],
    }),
  );
  const journal = {
    temporalSnapshot: () => ({ focused: new Map(), navigated: new Map() }),
    windowMru: () => [],
  } as unknown as JournalStore;
  return { store, journal, selections: new SelectionStore(), plans: new PlanStore() };
}

const members = {
  kind: "members",
  nodes: { kind: "ids", ids: ["w:chrome:x1"] },
  relation: "tabs",
};

describe("planTabChange", () => {
  it("plans from an inline selector and materializes a retrievable plan", () => {
    const d = deps();
    const out = planTabChange({ selector: members, transform: { kind: "reverse" } }, d);
    expect(out.riskClass).toBe("live-layout");
    expect(out.effectCount).toBeGreaterThan(0);
    expect(out.selectionKeys).toEqual(["a", "b", "c"]);
    const rec = d.plans.get(out.planId, d.store.getSnapshot().snapshotToken);
    expect(rec?.stale).toBe(false);
    expect(rec?.effects).toEqual(out.effects);
  });

  it("plans from a current selectionId", () => {
    const d = deps();
    const sel = selectTabs({ selector: members, projection: "ids" }, d);
    const out = planTabChange(
      {
        selectionId: sel.resolution.selectionId,
        transform: { kind: "move", destination: { kind: "slot", windowId: "w:chrome:x1", at: -1 } },
      },
      d,
    );
    expect(out.selectionKeys).toEqual(["a", "b", "c"]);
    expect(out.warnings.join(" ")).toMatch(/no-op/); // already in order at the end? a,b,c to -1 → same order = no-op
  });

  it("a STALE selection is refused, never silently re-resolved", () => {
    const d = deps();
    const sel = selectTabs({ selector: members, projection: "ids" }, d);
    // Move the state: revision bumps, token changes.
    const snap = d.store.getSnapshot();
    const w = snap.browsers[0]?.windows[0];
    if (w?.tabs[0]) {
      d.store.update({
        ...snap,
        browsers: [
          {
            ...(snap.browsers[0] as object),
            windows: [{ ...(w as object), tabs: w.tabs.slice(1) } as never],
          } as never,
        ],
      });
    }
    expect(() =>
      planTabChange({ selectionId: sel.resolution.selectionId, transform: { kind: "reverse" } }, d),
    ).toThrow(/different snapshot|re-run select_tabs/);
  });

  it("requires exactly one of selector | selectionId", () => {
    const d = deps();
    expect(() => planTabChange({ transform: { kind: "reverse" } }, d)).toThrow(/exactly one/);
    expect(() =>
      planTabChange(
        { selector: members, selectionId: "deadbeef", transform: { kind: "reverse" } },
        d,
      ),
    ).toThrow(/exactly one/);
  });

  it("planner policy errors pass through with their codes intact", () => {
    const d = deps();
    expect(() =>
      planTabChange(
        {
          selector: members,
          transform: { kind: "move", destination: { kind: "anchor", tabId: "a", offset: 1 } },
        },
        d,
      ),
    ).toThrow(/inside the selection/);
  });

  it("rejects a malformed transform at schema level", () => {
    const d = deps();
    expect(() =>
      planTabChange({ selector: members, transform: { kind: "interleave" } }, d),
    ).toThrow();
  });
});
