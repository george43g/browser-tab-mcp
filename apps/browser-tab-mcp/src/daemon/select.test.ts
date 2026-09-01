/**
 * selectTabs orchestration — validate → bind → resolve → project →
 * materialize against ONE snapshot read. The journal is stubbed to its
 * temporalSnapshot surface (its own behavior has its own tests); the state
 * and selection stores are real so token/materialization plumbing is proven,
 * not mimed.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import type { JournalStore } from "./journal.js";
import { selectTabs } from "./select.js";
import { SelectionStore } from "./selections.js";
import { StateStore } from "./state.js";

function deps(temporal?: { focused?: Map<string, number>; navigated?: Map<string, number> }) {
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
                makeContractTab({
                  tabId: "t:chrome:x10",
                  index: 0,
                  url: "https://github.com/a",
                  title: "A",
                  active: true,
                }),
                makeContractTab({
                  tabId: "t:chrome:x11",
                  index: 1,
                  url: "https://example.org/b",
                  title: "B",
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  );
  const journal = {
    temporalSnapshot: () => ({
      focused: temporal?.focused ?? new Map<string, number>(),
      navigated: temporal?.navigated ?? new Map<string, number>(),
    }),
  } as unknown as JournalStore;
  const selections = new SelectionStore();
  return { store, journal, selections };
}

const allTabs = { kind: "scope", scope: "allTabs" };

describe("selectTabs", () => {
  it("core rows carry the flat tab shape and resolution metadata", () => {
    const d = deps();
    const out = selectTabs(
      {
        selector: {
          kind: "where",
          scope: allTabs,
          predicate: { kind: "cmp", field: "host", op: "eq", value: "github.com" },
        },
      },
      d,
    );
    expect(out.count).toBe(1);
    expect(out.rows).toEqual([
      {
        tabId: "t:chrome:x10",
        windowId: "w:chrome:x1",
        browser: "chrome",
        index: 0,
        title: "A",
        url: "https://github.com/a",
        active: true,
        groupId: undefined,
      },
    ]);
    expect(out.resolution.kind).toBe("tab");
    expect(out.resolution.snapshotToken).toBe(d.store.getSnapshot().snapshotToken);
    expect(out.resolution.liveMoveDomains).toEqual({
      domains: ["ext:chrome:normal"],
      unknownCount: 0,
      uniform: true,
    });
  });

  it("materializes a retrievable, non-stale selection", () => {
    const d = deps();
    const out = selectTabs({ selector: allTabs, projection: "ids" }, d);
    expect(out.ids).toEqual(["t:chrome:x10", "t:chrome:x11"]);
    const rec = d.selections.get(out.resolution.selectionId, d.store.getSnapshot().snapshotToken);
    expect(rec?.keys).toEqual(["t:chrome:x10", "t:chrome:x11"]);
    expect(rec?.stale).toBe(false);
  });

  it("count projection returns no rows or ids", () => {
    const out = selectTabs({ selector: allTabs, projection: "count" }, deps());
    expect(out.count).toBe(2);
    expect(out.rows).toBeUndefined();
    expect(out.ids).toBeUndefined();
  });

  it("a structural selection under core answers ids plus a warning, not zero rows", () => {
    const out = selectTabs({ selector: { kind: "scope", scope: "allWindows" } }, deps());
    expect(out.count).toBe(1);
    expect(out.rows).toBeUndefined();
    expect(out.ids).toEqual(["w:chrome:x1"]);
    expect(out.resolution.warnings.join(" ")).toMatch(/core rows apply to tabs/);
  });

  it("an unknown scope fails validation BEFORE resolution, naming the valid scopes", () => {
    expect(() => selectTabs({ selector: { kind: "scope", scope: "allTabz" } }, deps())).toThrow(
      /allTabs/,
    );
  });

  it("temporal predicates read the journal maps; unknown tabs are excluded", () => {
    const d = deps({ focused: new Map([["t:chrome:x10", 1_756_000_000_000]]) });
    const out = selectTabs(
      {
        selector: {
          kind: "where",
          scope: allTabs,
          predicate: { kind: "cmp", field: "lastFocusedAt", op: "ge", value: 1 },
        },
        projection: "ids",
      },
      d,
    );
    // x11 has no journal record — the unknown policy EXCLUDES it rather than
    // treating unknown as 0 (which ge:1 would also exclude, so pin the
    // inverse too: a lt predicate must not sweep the unknown tab in).
    expect(out.ids).toEqual(["t:chrome:x10"]);
    const lt = selectTabs(
      {
        selector: {
          kind: "where",
          scope: allTabs,
          predicate: { kind: "cmp", field: "lastFocusedAt", op: "lt", value: 9_999_999_999_999 },
        },
        projection: "ids",
      },
      d,
    );
    expect(lt.ids).toEqual(["t:chrome:x10"]);
  });
});
