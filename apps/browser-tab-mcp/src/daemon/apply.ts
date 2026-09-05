/**
 * `apply_tab_layout` — DSL Phase 3 PR-E. The FIRST executor of the five-tool
 * surface, and deliberately the narrowest: it accepts ONLY a materialized
 * plan whose riskClass is "live-layout" — never copy, cut, or close
 * (spec §26.2; the classifier in select/plan/effects.ts is the gate).
 *
 * Execution discipline (spec §14.2 / §15):
 * - a STALE plan is refused (conflict:"error") — state moved since planning;
 * - neighbor-identity effects translate to concrete indexes against a LOCAL
 *   strip simulation seeded from the apply-start snapshot (token-equal to
 *   the plan's, so it IS the plan's world), advanced after each success —
 *   deterministic, immune to event-push timing;
 * - each relocate drives the EXISTING move_tab pathway (settled tabs.get,
 *   immediate post-command snapshot push — the proven discipline), so the
 *   wire and the extension stay untouched;
 * - the first failed effect ABORTS the remainder (recorded as skipped): with
 *   no browser transaction to lean on, compounding onto a failed arrangement
 *   trades a recoverable partial for an unpredictable one;
 * - the result reports ACTUAL final state: a post-apply refresh, per-window
 *   comparison against the expected arrangement, and a residual naming any
 *   window that differs. The intended plan is never reported as applied.
 */

import type { Snapshot } from "@george43g/shared-types";
import { z } from "zod";
import {
  ACT_VERB_RISK,
  type ActEffect,
  type Effect,
  type RelocateEffect,
} from "../select/plan/effects.js";
import type { OperationStore, OperationUndo } from "./operations.js";
import type { MaterializedPlan, PlanStore } from "./plans.js";
import type { StateStore } from "./state.js";

export const ApplyParamsSchema = z.object({
  planId: z.string().describe("A current plan_tab_change planId with riskClass live-layout."),
  conflict: z
    .enum(["error", "replan", "best-effort"])
    .default("error")
    .describe(
      'Stale-plan policy (§14.1). "error" refuses (default). "replan" re-plans the SAME ' +
        "members (by stored identity keys, never by re-running the original selector — a " +
        "conflict retry must not silently widen scope) against the fresh snapshot, budget 1, " +
        'and applies only if riskClass is unchanged. "best-effort" applies each effect whose ' +
        "preconditions still hold against the CURRENT snapshot and reports the rest as " +
        "skipped; failures do not cascade-abort.",
    ),
});

export interface EffectResult {
  effect: Effect;
  status: "applied" | "failed" | "skipped";
  error?: string;
}

export interface ApplyResult {
  status: "success" | "partial" | "failed";
  planId: string;
  results: EffectResult[];
  /** windowId → actual final tab order (affected windows only). */
  actual: Record<string, string[]>;
  /** Windows whose actual order differs from the plan's expected order. */
  residual: Array<{ windowId: string; expected: string[]; actual: string[] }>;
  snapshotTokenBefore?: string | undefined;
  snapshotTokenAfter?: string | undefined;
  /** Set when conflict:"replan" re-planned a stale plan before applying. */
  replanned?: boolean | undefined;
  /** The fresh plan replan executed (the input planId names the stale one). */
  appliedPlanId?: string | undefined;
  /** Durable operation-journal id for this execution. */
  operationId?: string | undefined;
}

export interface ApplyDeps {
  store: StateStore;
  plans: PlanStore;
  /** The daemon's executeCommand, pre-bound to its deps. */
  runCommand: (params: Record<string, unknown>) => Promise<unknown>;
  /** Force a fresh scan and return the merged snapshot. */
  refresh: () => Promise<Snapshot>;
  /** Operation journal (PR-I). Optional so pure planning tests stay small. */
  operations?: OperationStore | undefined;
  /**
   * Re-plan by identity for conflict:"replan": given the stale plan record,
   * produce a fresh one against the CURRENT snapshot (daemon wires this to
   * planTabChange with `{kind:"ids"}` over the stored selectionKeys).
   */
  replan?: ((stale: MaterializedPlan) => { planId: string }) | undefined;
}

function stripsOf(snapshot: Snapshot): Map<string, string[]> {
  const strips = new Map<string, string[]>();
  for (const b of snapshot.browsers) {
    for (const w of b.windows) {
      strips.set(
        w.windowId,
        w.tabs.map((t) => t.tabId),
      );
    }
  }
  return strips;
}

/** Apply one after-chained relocate to the local simulation. */
function simulate(strips: Map<string, string[]>, e: RelocateEffect): void {
  for (const [, order] of strips) {
    const i = order.indexOf(e.tabId);
    if (i >= 0) order.splice(i, 1);
  }
  const dest = strips.get(e.targetWindowId);
  if (!dest) throw new Error(`window ${e.targetWindowId} vanished from the simulation`);
  if (e.after === null) {
    dest.unshift(e.tabId);
  } else {
    const at = dest.indexOf(e.after);
    if (at < 0) throw new Error(`neighbor ${e.after} not in ${e.targetWindowId}`);
    dest.splice(at + 1, 0, e.tabId);
  }
}

/**
 * Execute an all-`act` plan (Phase 5 PR-M).
 *
 * Two command shapes, deliberately not unified: pin/unpin/mute/unmute are
 * per-tab `tab_action` calls, while group/ungroup are ONE `group_tabs` call
 * over the whole member list — because that is what the browser offers, and
 * fanning a group into N single-tab calls would create N groups instead of
 * one. The effect list stays per-tab either way, so the plan a caller reads is
 * the same shape regardless of how it is executed; a batch verb's outcome is
 * recorded against every effect it covered.
 *
 * There is no expected-arrangement check here and no residual: an act does not
 * move anything, so the relocation executor's whole verification model — which
 * exists because a browser can clamp or reorder around a move — has nothing to
 * verify. The honest report is the per-effect outcome plus the ACTUAL
 * post-state, re-read from the browser rather than assumed.
 */
async function applyActs(
  input: z.infer<typeof ApplyParamsSchema>,
  rec: MaterializedPlan,
  before: Snapshot,
  deps: ApplyDeps,
  replanned: boolean,
  tool: "apply_tab_layout" | "apply_destructive_plan" = "apply_tab_layout",
): Promise<ApplyResult> {
  const effects = rec.effects as ActEffect[];
  const bestEffort = input.conflict === "best-effort";

  // §15 undo: the BEFORE value of exactly the attribute each verb changes.
  // Read from the apply-start snapshot, which is token-equal to the plan's
  // world under both strict modes.
  const byId = new Map<
    string,
    { pinned?: boolean; muted?: boolean; groupId?: string | undefined }
  >();
  for (const b of before.browsers) {
    for (const w of b.windows) {
      for (const t of w.tabs) {
        byId.set(t.tabId, { pinned: t.pinned, muted: t.muted, groupId: t.groupId });
      }
    }
  }
  const attributes: Array<{
    tabId: string;
    pinned?: boolean;
    muted?: boolean;
    groupId?: string | null;
  }> = [];
  for (const e of effects) {
    const prev = byId.get(e.tabId);
    if (prev === undefined) continue;
    if (e.action === "pin" || e.action === "unpin") {
      attributes.push({ tabId: e.tabId, pinned: prev.pinned === true });
    } else if (e.action === "mute" || e.action === "unmute") {
      attributes.push({ tabId: e.tabId, muted: prev.muted === true });
    } else if (e.action === "group" || e.action === "ungroup") {
      attributes.push({ tabId: e.tabId, groupId: prev.groupId ?? null });
    }
  }

  const results: EffectResult[] = [];
  let failed = false;

  const batchVerb = effects[0]?.action === "group" || effects[0]?.action === "ungroup";
  if (batchVerb) {
    const first = effects[0] as ActEffect;
    const tabIds = effects.map((e) => e.tabId);
    const params: Record<string, unknown> =
      first.action === "ungroup"
        ? { kind: "group_tabs", action: "remove", tabIds }
        : first.groupId !== undefined
          ? { kind: "group_tabs", action: "add", tabIds, groupId: first.groupId }
          : { kind: "group_tabs", action: "create", tabIds };
    try {
      await deps.runCommand(params);
      for (const e of effects) results.push({ effect: e, status: "applied" });
    } catch (err) {
      failed = true;
      const error = (err as Error).message;
      for (const e of effects) results.push({ effect: e, status: "failed", error });
    }
  } else {
    for (const e of effects) {
      if (failed && !bestEffort) {
        results.push({ effect: e, status: "skipped" });
        continue;
      }
      try {
        await deps.runCommand({ kind: "tab_action", tabId: e.tabId, action: e.action });
        results.push({ effect: e, status: "applied" });
      } catch (err) {
        results.push({ effect: e, status: "failed", error: (err as Error).message });
        failed = true;
      }
    }
  }

  const after = await deps.refresh();
  const affected = new Set(
    effects
      .map((e) => {
        for (const b of after.browsers)
          for (const w of b.windows) if (w.tabs.some((t) => t.tabId === e.tabId)) return w.windowId;
        return undefined;
      })
      .filter((w): w is string => w !== undefined),
  );
  const actualStrips = stripsOf(after);
  const actual: Record<string, string[]> = {};
  for (const wid of affected) actual[wid] = actualStrips.get(wid) ?? [];

  const applied = results.filter((r) => r.status === "applied").length;
  const status: ApplyResult["status"] = failed ? (applied > 0 ? "partial" : "failed") : "success";
  const result: ApplyResult = {
    status,
    planId: input.planId,
    results,
    actual,
    residual: [],
    snapshotTokenBefore: before.snapshotToken,
    snapshotTokenAfter: after.snapshotToken,
    ...(replanned ? { replanned: true, appliedPlanId: rec.planId } : {}),
  };
  // A plan carries one transform, so one verb. If that verb throws away
  // in-page state, `pre-attributes` would be a lie — it records pinned/muted/
  // groupId, none of which is what a discard destroyed. Record the loss.
  const verb = effects[0]?.action;
  const undo: OperationUndo =
    verb !== undefined && ACT_VERB_RISK[verb] === "destructive"
      ? { kind: "state-lost", verb, tabIds: effects.map((e) => e.tabId) }
      : { kind: "pre-attributes", attributes };
  const op = deps.operations?.record({
    tool,
    status,
    planId: input.planId,
    request: input,
    outcomes: results,
    residual: [],
    snapshotTokenBefore: before.snapshotToken,
    snapshotTokenAfter: after.snapshotToken,
    conflictMode: input.conflict,
    ...(replanned ? { replanned: true } : {}),
    undo,
  });
  if (op !== undefined) result.operationId = op.operationId;
  return result;
}

export const DestructiveApplyParamsSchema = z.object({
  planId: z.string(),
  confirmDestruction: z.literal(true),
});

/**
 * The other door (Phase 5 PR-N) — `apply_tab_layout` stays live-layout-only.
 *
 * Why a second tool rather than a flag on the first: §26.2 risk-coherent
 * tools. `apply_tab_layout` is annotated `destructiveHint: false`, and a
 * caller — usually a model — decides what it dares call from the annotation.
 * A flag that flips a non-destructive tool into a destructive one makes that
 * annotation a lie exactly when it matters. So the risk lives in the tool's
 * NAME, and `confirmDestruction` is the same explicit gate `cut_tabs` already
 * uses rather than a second contract to learn.
 *
 * Three refusals, each pointing somewhere real:
 *  - a live-layout plan is sent back to `apply_tab_layout` (nothing here is
 *    safer, and running it through the destructive door would train a caller
 *    to reach for the destructive door);
 *  - a plan containing reconstruction/closure effects is sent to
 *    `copy_tabs`/`cut_tabs`, which own verify-then-close;
 *  - a STALE plan is refused outright and is never re-planned. `conflict:
 *    "replan"` exists on the live door because re-deriving a move against
 *    fresh state is cheap to be wrong about. Re-deriving a DISCARD is not:
 *    the world changed, and the set of tabs the caller meant may no longer be
 *    the set the selector now matches. A human re-plans.
 */
export async function applyDestructivePlan(
  params: Record<string, unknown>,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const input = DestructiveApplyParamsSchema.parse(params);
  const before = deps.store.getSnapshot();
  const rec = deps.plans.get(input.planId, before.snapshotToken);
  if (rec === undefined) {
    throw new Error(
      `plan "${input.planId}" is unknown or expired — plans are snapshot-bound and ` +
        `short-lived; re-run plan_tab_change.`,
    );
  }
  if (rec.stale) {
    throw new Error(
      `plan "${input.planId}" was computed against a different snapshot (state has changed ` +
        `since) — re-run plan_tab_change and confirm the fresh plan. A destructive plan is ` +
        `never re-planned on your behalf.`,
    );
  }
  if (rec.riskClass !== "destructive") {
    throw new Error(
      `plan "${input.planId}" has riskClass "${rec.riskClass}", not "destructive" — apply it ` +
        `with apply_tab_layout, which needs no confirmation because nothing is lost.`,
    );
  }
  const nonAct = rec.effects.find((e) => e.kind !== "act");
  if (nonAct !== undefined) {
    throw new Error(
      `plan "${input.planId}" contains a "${nonAct.kind}" effect — this tool applies destructive ` +
        `ACTS (discard/reload) only. Reconstructive transfer, which closes sources after ` +
        `verifying their replacements, goes through copy_tabs/cut_tabs.`,
    );
  }
  return await applyActs(
    { planId: input.planId, conflict: "error" },
    rec,
    before,
    deps,
    false,
    "apply_destructive_plan",
  );
}

export async function applyTabLayout(
  params: Record<string, unknown>,
  deps: ApplyDeps,
): Promise<ApplyResult> {
  const input = ApplyParamsSchema.parse(params);
  const bestEffort = input.conflict === "best-effort";
  const before = deps.store.getSnapshot();
  let rec = deps.plans.get(input.planId, before.snapshotToken);
  if (rec === undefined) {
    throw new Error(
      `plan "${input.planId}" is unknown or expired — plans are snapshot-bound and ` +
        `short-lived; re-run plan_tab_change.`,
    );
  }
  let replanned = false;
  if (rec.stale && input.conflict === "error") {
    throw new Error(
      `plan "${input.planId}" was computed against a different snapshot (state has changed ` +
        `since) — re-run plan_tab_change and apply the fresh plan, or pass ` +
        `conflict:"replan"/"best-effort".`,
    );
  }
  if (rec.stale && input.conflict === "replan") {
    // Budget 1 (plan PR-I): one identity-preserving re-plan, then apply or
    // error — never a loop against a busy browser.
    if (deps.replan === undefined) {
      throw new Error('conflict:"replan" is not available on this pathway — re-plan manually.');
    }
    const staleRisk = rec.riskClass;
    const fresh = deps.replan(rec);
    const freshRec = deps.plans.get(fresh.planId, before.snapshotToken);
    if (freshRec === undefined || freshRec.stale) {
      throw new Error(
        "replan raced another state change (budget 1 spent) — re-run plan_tab_change.",
      );
    }
    if (freshRec.riskClass !== staleRisk) {
      throw new Error(
        `replan changed riskClass ("${staleRisk}" → "${freshRec.riskClass}") — the situation ` +
          `moved under the plan; re-plan and re-authorize deliberately.`,
      );
    }
    rec = { ...freshRec };
    replanned = true;
  }
  if (rec.riskClass !== "live-layout") {
    // The route out depends on WHY it is destructive, and pointing a discard
    // plan at copy_tabs/cut_tabs would be confidently wrong advice.
    const actVerbs = [...new Set(rec.effects.filter((e) => e.kind === "act").map((e) => e.action))];
    throw new Error(
      `plan "${input.planId}" has riskClass "${rec.riskClass}" — apply_tab_layout applies ` +
        `only live-layout plans. ` +
        (actVerbs.length > 0
          ? `The verb(s) ${actVerbs.join("/")} throw away in-page state, and no batch executor ` +
            `accepts them yet (Phase 5 PR-N) — run tab_action per tab, deliberately.`
          : `Reconstructive transfer goes through copy_tabs/cut_tabs.`),
    );
  }

  // A plan carries exactly ONE transform, so its effects are homogeneous: an
  // `act` plan is all acts and a relocation plan is all relocates. Acts get
  // their own executor rather than a third branch inside the relocation loop —
  // that loop is LIS-minimal neighbour-identity translation with a simulated
  // strip and an expected-arrangement check, and NONE of it means anything for
  // a verb that changes a tab's own state without moving it. (Phase 5 PR-M.)
  if (rec.effects.length > 0 && rec.effects.every((e) => e.kind === "act")) {
    return await applyActs(input, rec, before, deps, replanned);
  }

  // Local translation state, seeded from the apply-start snapshot (token-equal
  // to the plan's world — except under best-effort on a stale plan, where the
  // CURRENT snapshot is deliberately the world effects are checked against).
  const sim = stripsOf(before);
  const affected = new Set<string>();
  const preState: Array<{ tabId: string; fromWindowId: string; fromIndex: number }> = [];
  for (const e of rec.effects) {
    if (e.kind !== "relocate") {
      throw new Error(
        `plan contains a "${e.kind}" effect, which the v1 live-layout executor does not ` +
          `emit or apply — re-plan with the current tool version.`,
      );
    }
    affected.add(e.targetWindowId);
    for (const [wid, order] of sim) {
      const i = order.indexOf(e.tabId);
      if (i >= 0) {
        affected.add(wid);
        // §15 undo record: the BEFORE-position no later snapshot can recover.
        preState.push({ tabId: e.tabId, fromWindowId: wid, fromIndex: i });
      }
    }
  }
  // Expected end arrangement: whole-plan under strict modes (any invalid
  // effect fails HERE, before mutation); under best-effort it is computed
  // AFTER execution from the applied subset, because a stale plan may carry
  // effects whose members are gone and those must skip, not abort.
  let expected: Map<string, string[]> | undefined;
  if (!bestEffort) {
    expected = stripsOf(before);
    for (const e of rec.effects as RelocateEffect[]) simulate(expected, e);
  }

  const results: EffectResult[] = [];
  let failed = false;
  for (const e of rec.effects as RelocateEffect[]) {
    if (failed && !bestEffort) {
      results.push({ effect: e, status: "skipped" });
      continue;
    }
    // Translate neighbor identity → concrete final index in the SIM world. A
    // precondition miss (window/member/neighbor gone) is a SKIP under
    // best-effort — nothing was attempted — and an abort otherwise.
    let targetIndex: number;
    try {
      const dest = sim.get(e.targetWindowId);
      if (!dest) throw new Error(`window ${e.targetWindowId} is gone`);
      if (bestEffort && ![...sim.values()].some((order) => order.includes(e.tabId))) {
        throw new Error(`tab ${e.tabId} is gone`);
      }
      const survivors = dest.filter((id) => id !== e.tabId);
      targetIndex =
        e.after === null
          ? 0
          : (() => {
              const at = survivors.indexOf(e.after);
              if (at < 0) throw new Error(`neighbor ${e.after} is gone from ${e.targetWindowId}`);
              return at + 1;
            })();
    } catch (err) {
      results.push({
        effect: e,
        status: bestEffort ? "skipped" : "failed",
        error: `precondition: ${(err as Error).message}`,
      });
      failed = true;
      continue;
    }
    try {
      await deps.runCommand({
        kind: "move_tab",
        tabId: e.tabId,
        targetWindowId: e.targetWindowId,
        targetIndex,
      });
      simulate(sim, e);
      results.push({ effect: e, status: "applied" });
    } catch (err) {
      results.push({ effect: e, status: "failed", error: (err as Error).message });
      failed = true;
    }
  }
  if (expected === undefined) {
    expected = new Map([...sim].map(([wid, order]) => [wid, [...order]]));
  }

  // ACTUAL final state — never report the intent as the outcome (§15).
  // Bounded settle: the extension's post-command snapshot push races a refresh
  // that starts the instant the last command resolves (measured against real
  // Chrome — both effects applied with settled per-move reads, yet the first
  // merged read still showed the penultimate arrangement). Re-read briefly
  // before declaring residual; genuine divergence survives every retry and is
  // reported from the LAST read. This is the per-command settled-read
  // discipline applied at batch level, not a masking of failure.
  let after = await deps.refresh();
  let actual: Record<string, string[]> = {};
  let residual: ApplyResult["residual"] = [];
  for (let attempt = 0; ; attempt++) {
    const actualStrips = stripsOf(after);
    actual = {};
    residual = [];
    for (const wid of affected) {
      const act = actualStrips.get(wid) ?? [];
      actual[wid] = act;
      const exp = expected.get(wid) ?? [];
      if (act.join(" ") !== exp.join(" ")) {
        residual.push({ windowId: wid, expected: exp, actual: act });
      }
    }
    if (residual.length === 0 || failed || attempt >= 3) break;
    await new Promise((r) => setTimeout(r, 150));
    after = await deps.refresh();
  }

  const applied = results.filter((r) => r.status === "applied").length;
  const status: ApplyResult["status"] = failed
    ? applied > 0
      ? "partial"
      : "failed"
    : residual.length > 0
      ? "partial"
      : "success";

  const result: ApplyResult = {
    status,
    planId: input.planId,
    results,
    actual,
    residual,
    snapshotTokenBefore: before.snapshotToken,
    snapshotTokenAfter: after.snapshotToken,
    ...(replanned ? { replanned: true, appliedPlanId: rec.planId } : {}),
  };
  const undo: OperationUndo = { kind: "pre-state", moves: preState };
  const op = deps.operations?.record({
    tool: "apply_tab_layout",
    status,
    planId: input.planId,
    request: input,
    outcomes: results,
    residual,
    snapshotTokenBefore: before.snapshotToken,
    snapshotTokenAfter: after.snapshotToken,
    conflictMode: input.conflict,
    ...(replanned ? { replanned: true } : {}),
    undo,
  });
  if (op !== undefined) result.operationId = op.operationId;
  return result;
}
