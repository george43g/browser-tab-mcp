/**
 * applyTabLayout — the executor's contracts: refusal gates (stale, non-live
 * riskClass), neighbor→index translation (including the remove-then-insert
 * off-by-one), abort-on-first-failure with skipped remainder, and honest
 * residual reporting against a browser model that actually moves tabs.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "@george43g/shared-types";
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { applyTabLayout } from "./apply.js";
import { OperationStore } from "./operations.js";
import { PlanStore } from "./plans.js";
import { StateStore } from "./state.js";

/** A tiny browser model with chrome.tabs.move semantics (remove, insert). */
function makeWorld(strips: Record<string, string[]>) {
  const model = new Map(Object.entries(strips).map(([w, t]) => [w, [...t]]));
  const snapshotOf = (): Snapshot =>
    makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: true,
          dataSource: "extension",
          windows: [...model.entries()].map(([windowId, tabs]) =>
            makeContractWindow({
              windowId,
              focused: windowId === [...model.keys()][0],
              tabs: tabs.map((tabId, index) => makeContractTab({ tabId, index })),
            }),
          ),
        }),
      ],
    });
  const store = new StateStore();
  store.update(snapshotOf());
  const moves: Array<{ tabId: string; targetWindowId: string; targetIndex: number }> = [];
  const runCommand = async (p: Record<string, unknown>) => {
    const { tabId, targetWindowId, targetIndex } = p as {
      tabId: string;
      targetWindowId: string;
      targetIndex: number;
    };
    moves.push({ tabId, targetWindowId, targetIndex });
    for (const [, order] of model) {
      const i = order.indexOf(tabId);
      if (i >= 0) order.splice(i, 1);
    }
    const dest = model.get(targetWindowId);
    if (!dest) throw new Error("no such window");
    dest.splice(targetIndex, 0, tabId);
    return { ok: true };
  };
  const refresh = async () => {
    store.update(snapshotOf());
    return store.getSnapshot();
  };
  return { model, store, moves, runCommand, refresh };
}

const relocate = (tabId: string, targetWindowId: string, after: string | null) => ({
  kind: "relocate" as const,
  tabId,
  targetWindowId,
  after,
});

function planOf(
  world: ReturnType<typeof makeWorld>,
  plans: PlanStore,
  effects: ReturnType<typeof relocate>[],
) {
  return plans.materialize({
    riskClass: "live-layout",
    effects,
    warnings: [],
    selectionKeys: effects.map((e) => e.tabId),
    snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
  });
}

describe("applyTabLayout", () => {
  it("applies a full reverse and reports success with zero residual", async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b", "c"] });
    const plans = new PlanStore();
    // Reverse via after-chain: c to front, b after c (a keeps via LIS).
    const rec = planOf(world, plans, [
      relocate("c", "w:chrome:x1", null),
      relocate("b", "w:chrome:x1", "c"),
    ]);
    const out = await applyTabLayout({ planId: rec.planId }, { ...world, plans });
    expect(out.status).toBe("success");
    expect(world.model.get("w:chrome:x1")).toEqual(["c", "b", "a"]);
    expect(out.actual["w:chrome:x1"]).toEqual(["c", "b", "a"]);
    expect(out.residual).toEqual([]);
    expect(out.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(out.snapshotTokenAfter).not.toBe(out.snapshotTokenBefore);
  });

  it("translates the remove-then-insert off-by-one correctly (T before N)", async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b", "c"] });
    const plans = new PlanStore();
    const rec = planOf(world, plans, [relocate("a", "w:chrome:x1", "b")]);
    const out = await applyTabLayout({ planId: rec.planId }, { ...world, plans });
    // survivors [b,c]; after b → index 1; chrome: remove a → [b,c], insert@1.
    expect(world.moves).toEqual([{ tabId: "a", targetWindowId: "w:chrome:x1", targetIndex: 1 }]);
    expect(world.model.get("w:chrome:x1")).toEqual(["b", "a", "c"]);
    expect(out.status).toBe("success");
  });

  it("refuses a stale plan without touching the browser", async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b"] });
    const plans = new PlanStore();
    const rec = planOf(world, plans, [relocate("b", "w:chrome:x1", null)]);
    // State moves after planning.
    world.model.get("w:chrome:x1")?.push("z");
    await world.refresh();
    await expect(applyTabLayout({ planId: rec.planId }, { ...world, plans })).rejects.toThrow(
      /different snapshot/,
    );
    expect(world.moves).toEqual([]);
  });

  it("refuses a non-live-layout plan by risk class", async () => {
    const world = makeWorld({ "w:chrome:x1": ["a"] });
    const plans = new PlanStore();
    const rec = plans.materialize({
      riskClass: "destructive",
      effects: [{ kind: "closeVerified", tabId: "a", contingentOn: "x" }],
      warnings: [],
      selectionKeys: ["a"],
      snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
    });
    await expect(applyTabLayout({ planId: rec.planId }, { ...world, plans })).rejects.toThrow(
      /riskClass "destructive"/,
    );
    expect(world.moves).toEqual([]);
  });

  it("settles a racing refresh: stale first read, fresh second — success, no residual", async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b", "c"] });
    const plans = new PlanStore();
    const rec = planOf(world, plans, [
      relocate("c", "w:chrome:x1", null),
      relocate("b", "w:chrome:x1", "c"),
    ]);
    // First refresh returns a snapshot MISSING the last move (the measured
    // extension-push race); the retry sees the true state.
    let reads = 0;
    const racyRefresh = async () => {
      reads += 1;
      if (reads === 1) {
        const halfDone = new Map(world.model);
        halfDone.set("w:chrome:x1", ["c", "a", "b"]); // effect 1 only
        const save = new Map(world.model);
        for (const [k, v] of halfDone) world.model.set(k, [...v]);
        const snap = await world.refresh();
        for (const [k, v] of save) world.model.set(k, [...v]);
        return snap;
      }
      return world.refresh();
    };
    const out = await applyTabLayout(
      { planId: rec.planId },
      { store: world.store, plans, runCommand: world.runCommand, refresh: racyRefresh },
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(out.status).toBe("success");
    expect(out.residual).toEqual([]);
    expect(out.actual["w:chrome:x1"]).toEqual(["c", "b", "a"]);
  });

  it("aborts on the first failure, skips the rest, and reports residual honestly", async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b", "c", "d"] });
    const plans = new PlanStore();
    const rec = planOf(world, plans, [
      relocate("d", "w:chrome:x1", null),
      relocate("c", "w:chrome:x1", "d"),
      relocate("b", "w:chrome:x1", "c"),
    ]);
    let calls = 0;
    const flaky = async (p: Record<string, unknown>) => {
      calls += 1;
      if (calls === 2) throw new Error("browser said no");
      return world.runCommand(p);
    };
    const out = await applyTabLayout(
      { planId: rec.planId },
      { store: world.store, plans, runCommand: flaky, refresh: world.refresh },
    );
    expect(out.status).toBe("partial");
    expect(out.results.map((r) => r.status)).toEqual(["applied", "failed", "skipped"]);
    expect(out.results[1]?.error).toMatch(/browser said no/);
    // Only the first effect landed: d moved to front, nothing else.
    expect(out.actual["w:chrome:x1"]).toEqual(["d", "a", "b", "c"]);
    expect(out.residual).toHaveLength(1);
    expect(out.residual[0]?.expected).toEqual(["d", "c", "b", "a"]);
  });

  it('conflict:"replan" re-plans a stale plan by identity and applies the fresh one', async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b", "c"] });
    const plans = new PlanStore();
    const stalePlan = planOf(world, plans, [relocate("a", "w:chrome:x1", "c")]);
    // State moves under the plan: token changes, the plan goes stale.
    world.model.get("w:chrome:x1")?.push("d");
    await world.refresh();
    const replan = (stale: { selectionKeys: string[] }) => {
      expect(stale.selectionKeys).toEqual(["a"]);
      return planOf(world, plans, [relocate("a", "w:chrome:x1", "c")]);
    };
    const out = await applyTabLayout(
      { planId: stalePlan.planId, conflict: "replan" },
      { store: world.store, plans, runCommand: world.runCommand, refresh: world.refresh, replan },
    );
    expect(out.status).toBe("success");
    expect(out.replanned).toBe(true);
    expect(out.appliedPlanId).not.toBe(stalePlan.planId);
    expect(world.model.get("w:chrome:x1")).toEqual(["b", "c", "a", "d"]);
  });

  it('conflict:"replan" refuses when the fresh plan changes riskClass, and without wiring', async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b"] });
    const plans = new PlanStore();
    const stalePlan = planOf(world, plans, [relocate("a", "w:chrome:x1", "b")]);
    world.model.get("w:chrome:x1")?.push("c");
    await world.refresh();
    await expect(
      applyTabLayout(
        { planId: stalePlan.planId, conflict: "replan" },
        { store: world.store, plans, runCommand: world.runCommand, refresh: world.refresh },
      ),
    ).rejects.toThrow(/not available on this pathway/);
    const riskChanger = () =>
      plans.materialize({
        riskClass: "destructive",
        effects: [],
        warnings: [],
        selectionKeys: ["a"],
        snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
      });
    await expect(
      applyTabLayout(
        { planId: stalePlan.planId, conflict: "replan" },
        {
          store: world.store,
          plans,
          runCommand: world.runCommand,
          refresh: world.refresh,
          replan: riskChanger,
        },
      ),
    ).rejects.toThrow(/replan changed riskClass/);
  });

  it('conflict:"best-effort" applies what still holds on a stale plan and skips the rest', async () => {
    const world = makeWorld({ "w:chrome:x1": ["a", "b", "c"] });
    const plans = new PlanStore();
    const plan = planOf(world, plans, [
      relocate("zz", "w:chrome:x1", "c"),
      relocate("a", "w:chrome:x1", "c"),
    ]);
    // "zz" never existed; state also moves so the plan is stale.
    world.model.get("w:chrome:x1")?.push("d");
    await world.refresh();
    const out = await applyTabLayout(
      { planId: plan.planId, conflict: "best-effort" },
      { store: world.store, plans, runCommand: world.runCommand, refresh: world.refresh },
    );
    expect(out.status).toBe("partial");
    expect(out.results.map((r) => r.status)).toEqual(["skipped", "applied"]);
    expect(out.results[0]?.error).toMatch(/precondition/);
    expect(world.model.get("w:chrome:x1")).toEqual(["b", "c", "a", "d"]);
  });

  it("records the operation with a §15 pre-state undo when a store is wired", async () => {
    const { OperationStore } = await import("./operations.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "bt-apply-ops-"));
    try {
      const operations = new OperationStore({ dir, ringSize: 10 });
      const world = makeWorld({ "w:chrome:x1": ["a", "b", "c"] });
      const plans = new PlanStore();
      const plan = planOf(world, plans, [relocate("a", "w:chrome:x1", "c")]);
      const out = await applyTabLayout(
        { planId: plan.planId },
        {
          store: world.store,
          plans,
          runCommand: world.runCommand,
          refresh: world.refresh,
          operations,
        },
      );
      expect(out.operationId).toMatch(/^[0-9a-f]{8}$/);
      const rec = operations.get(out.operationId as string);
      expect(rec?.tool).toBe("apply_tab_layout");
      expect(rec?.conflictMode).toBe("error");
      // The BEFORE-position no later snapshot can recover (§15).
      expect(rec?.undo).toEqual({
        kind: "pre-state",
        moves: [{ tabId: "a", fromWindowId: "w:chrome:x1", fromIndex: 0 }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The act executor (Phase 5 PR-M). A separate world, because acts change a
 * tab's own attributes rather than the strip, and the relocation world models
 * only position.
 */
function makeActWorld(tabs: Array<{ tabId: string; muted?: boolean; groupId?: string }>) {
  const state = tabs.map((t) => ({ ...t }));
  const snapshotOf = (): Snapshot =>
    makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: true,
          dataSource: "extension",
          windows: [
            makeContractWindow({
              windowId: "w:chrome:x1",
              focused: true,
              tabs: state.map((t, index) =>
                makeContractTab({
                  tabId: t.tabId,
                  index,
                  muted: t.muted === true,
                  ...(t.groupId !== undefined ? { groupId: t.groupId } : {}),
                }),
              ),
            }),
          ],
        }),
      ],
    });
  const store = new StateStore();
  store.update(snapshotOf());
  const commands: Record<string, unknown>[] = [];
  const failOn = new Set<string>();
  const runCommand = async (p: Record<string, unknown>) => {
    commands.push(p);
    if (p.kind === "tab_action") {
      const tabId = p.tabId as string;
      if (failOn.has(tabId)) throw new Error(`tab ${tabId} is gone`);
      const t = state.find((x) => x.tabId === tabId);
      if (t) t.muted = p.action === "mute";
    }
    return { ok: true };
  };
  const refresh = async () => {
    store.update(snapshotOf());
    return store.getSnapshot();
  };
  return { state, store, commands, failOn, runCommand, refresh };
}

const actEffect = (tabId: string, action: string, groupId?: string) => ({
  kind: "act" as const,
  tabId,
  action: action as "mute",
  ...(groupId !== undefined ? { groupId } : {}),
});

describe("applyTabLayout — act plans", () => {
  it("fans a per-tab verb into one tab_action each and records the BEFORE attribute", async () => {
    const world = makeActWorld([
      { tabId: "a", muted: false },
      { tabId: "b", muted: true },
    ]);
    const plans = new PlanStore();
    const operations = new OperationStore({ dir: mkdtempSync(join(tmpdir(), "bt-ops-")) });
    const rec = plans.materialize({
      riskClass: "live-layout",
      effects: [actEffect("a", "mute"), actEffect("b", "mute")],
      warnings: [],
      selectionKeys: ["a", "b"],
      snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
    });
    const out = await applyTabLayout({ planId: rec.planId }, { ...world, plans, operations });

    expect(out.status).toBe("success");
    expect(world.commands).toEqual([
      { kind: "tab_action", tabId: "a", action: "mute" },
      { kind: "tab_action", tabId: "b", action: "mute" },
    ]);
    // No residual concept for acts: nothing moved, so there is no arrangement
    // to diverge from. Reporting one would be inventing a verification.
    expect(out.residual).toEqual([]);
    const undo = operations.list(1)[0]?.undo;
    expect(undo).toEqual({
      kind: "pre-attributes",
      attributes: [
        { tabId: "a", muted: false },
        { tabId: "b", muted: true },
      ],
    });
  });

  it("issues ONE group_tabs call for a batch verb, not one per member", async () => {
    // Fanning group into N single-tab calls would create N groups. The effect
    // list stays per-tab so the plan reads the same either way.
    const world = makeActWorld([{ tabId: "a" }, { tabId: "b" }, { tabId: "c" }]);
    const plans = new PlanStore();
    const rec = plans.materialize({
      riskClass: "live-layout",
      effects: [actEffect("a", "group"), actEffect("b", "group"), actEffect("c", "group")],
      warnings: [],
      selectionKeys: ["a", "b", "c"],
      snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
    });
    const out = await applyTabLayout({ planId: rec.planId }, { ...world, plans });
    expect(world.commands).toEqual([
      { kind: "group_tabs", action: "create", tabIds: ["a", "b", "c"] },
    ]);
    expect(out.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
  });

  it("ungroup removes the whole member list in one call", async () => {
    const world = makeActWorld([{ tabId: "a", groupId: "g:chrome:x7" }]);
    const plans = new PlanStore();
    const rec = plans.materialize({
      riskClass: "live-layout",
      effects: [actEffect("a", "ungroup")],
      warnings: [],
      selectionKeys: ["a"],
      snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
    });
    await applyTabLayout({ planId: rec.planId }, { ...world, plans });
    expect(world.commands).toEqual([{ kind: "group_tabs", action: "remove", tabIds: ["a"] }]);
  });

  it("aborts the remainder on a per-tab failure, like the relocation executor", async () => {
    const world = makeActWorld([{ tabId: "a" }, { tabId: "b" }, { tabId: "c" }]);
    world.failOn.add("b");
    const plans = new PlanStore();
    const rec = plans.materialize({
      riskClass: "live-layout",
      effects: [actEffect("a", "mute"), actEffect("b", "mute"), actEffect("c", "mute")],
      warnings: [],
      selectionKeys: ["a", "b", "c"],
      snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
    });
    const out = await applyTabLayout({ planId: rec.planId }, { ...world, plans });
    expect(out.results.map((r) => r.status)).toEqual(["applied", "failed", "skipped"]);
    expect(out.status).toBe("partial");
  });

  it("refuses a destructive-classed act plan through the same gate as a cut", async () => {
    const world = makeActWorld([{ tabId: "a" }]);
    const plans = new PlanStore();
    const rec = plans.materialize({
      riskClass: "destructive",
      effects: [actEffect("a", "discard")],
      warnings: [],
      selectionKeys: ["a"],
      snapshotToken: world.store.getSnapshot().snapshotToken ?? "",
    });
    await expect(applyTabLayout({ planId: rec.planId }, { ...world, plans })).rejects.toThrow(
      /applies\s+only live-layout plans/,
    );
    // …and the refusal names the ACT route, not copy/cut — pointing a discard
    // at reconstructive transfer would be confidently wrong advice.
    await expect(applyTabLayout({ planId: rec.planId }, { ...world, plans })).rejects.toThrow(
      /discard[\s\S]*tab_action per tab/,
    );
    expect(world.commands).toEqual([]);
  });
});
