/**
 * StateStore revision semantics — the monotonic state revision + opaque
 * snapshotToken that future snapshot-bound selectors/plans key on.
 *
 * The invariants pinned here, in order of how expensive they'd be to lose:
 *   1. `version` stays literal 2 — revision is a NEW field, not a repurposing
 *      of the contract version ("fixing" version to count states breaks every
 *      consumer that gates on the contract shape).
 *   2. Revision bumps on CONTENT change and only content change — not on a
 *      re-assembly whose only difference is `generatedAt` (the poll loop
 *      reassembles every tick; a per-tick bump would make every token stale
 *      before a caller could use it).
 *   3. Revision bumps on changes the EVENT diff deliberately ignores —
 *      enrichment blips and a browser vanishing wholesale (see
 *      state-diff.test.ts for why events stay quiet) — because a concurrency
 *      token that misses a state change silently validates a stale plan.
 *   4. Tokens are equality-only: same revision number, different boot ⇒
 *      different token.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { StateStore } from "./state.js";

const oneTab = (tab: Parameters<typeof makeContractTab>[0] = {}) =>
  makeSnapshot({
    browsers: [
      makeBrowserState({ windows: [makeContractWindow({ tabs: [makeContractTab(tab)] })] }),
    ],
  });

describe("StateStore revision", () => {
  it("starts at 0 with a well-formed token, version stays 2", () => {
    const store = new StateStore();
    const snap = store.getSnapshot();
    expect(snap.version).toBe(2);
    expect(snap.revision).toBe(0);
    expect(snap.snapshotToken).toMatch(/^[0-9a-f]{8}:0$/);
  });

  it("bumps on content change and stamps the served snapshot", () => {
    const store = new StateStore();
    store.update(oneTab());
    const snap = store.getSnapshot();
    expect(snap.revision).toBe(1);
    expect(snap.snapshotToken).toMatch(/^[0-9a-f]{8}:1$/);
    expect(snap.version).toBe(2);
  });

  it("does NOT bump when only generatedAt moved (idle poll tick)", () => {
    const store = new StateStore();
    store.update(oneTab());
    store.update({ ...oneTab(), generatedAt: Date.now() + 60_000 });
    expect(store.getSnapshot().revision).toBe(1);
  });

  it("bumps on an enrichment-only change the event diff ignores", () => {
    const store = new StateStore();
    store.update(oneTab());
    const events: string[] = [];
    store.onEvent((e) => events.push(e.event));
    store.update(oneTab({ audible: true }));
    // Sabotage guard both ways: the event diff stays quiet (that is
    // state-diff.test.ts's contract), yet the revision must still move.
    expect(events).toEqual([]);
    expect(store.getSnapshot().revision).toBe(2);
  });

  it("bumps when a browser vanishes wholesale (zero events emitted)", () => {
    const store = new StateStore();
    store.update(oneTab());
    store.update(makeSnapshot({ browsers: [] }));
    expect(store.getSnapshot().revision).toBe(2);
  });

  it("is monotonic across a change-revert-change sequence", () => {
    const store = new StateStore();
    store.update(oneTab());
    store.update(oneTab({ title: "changed" }));
    store.update(oneTab());
    expect(store.getSnapshot().revision).toBe(3);
  });

  it("tokens never collide across daemon runs at the same revision", () => {
    const a = new StateStore();
    const b = new StateStore();
    a.update(oneTab());
    b.update(oneTab());
    expect(a.getSnapshot().revision).toBe(b.getSnapshot().revision);
    expect(a.getSnapshot().snapshotToken).not.toBe(b.getSnapshot().snapshotToken);
  });

  it("the snapshot event carries the stamped revision/token", () => {
    const store = new StateStore();
    let seen: { revision?: number; snapshotToken?: string } | undefined;
    store.onEvent((e) => {
      if (e.event === "snapshot") seen = e.data as typeof seen;
    });
    store.update(oneTab());
    expect(seen?.revision).toBe(1);
    expect(seen?.snapshotToken).toMatch(/^[0-9a-f]{8}:1$/);
  });
});
