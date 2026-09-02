/**
 * `copy_tabs` — DSL Phase 3 PR-F. Additive reconstructive transfer
 * (spec §9.3): reconstruct each selected tab at the destination and leave
 * every source UNTOUCHED — the safety property is structural (this module
 * contains no close pathway at all), not behavioral.
 *
 * Copy is the operation that legitimately crosses live-move domains — it is
 * how tabs travel between browsers — so unlike plan/apply there is no
 * uniformity gate. What IS enforced per URL is the same scheme allowlist the
 * open pathway applies (src/tools/url-policy.ts): a URL the policy refuses
 * is SKIPPED with a per-item reason (§7 freeze row: non-reconstructable →
 * skip + report), never a batch abort.
 *
 * Creation order is resolved selection order; each creation drives the
 * EXISTING open_tab pathway. Pinned intent is best-effort re-applied via
 * tab_action pin; group intent is NOT recreated in v1 (reported as a
 * warning — staged, recorded in the phase plan). `idempotencyKey`: a retry
 * bearing the same key returns the stored outcome instead of minting
 * duplicate tabs (spec §9.4's retry rule, applied to copy).
 */

import { assertValid, parseSelector, resolveSelector } from "@george43g/control-language";
import { z } from "zod";
import { type BrowserRef, makeBrowserDomain } from "../select/browser-domain.js";
import { mapTemporalProvider } from "../select/temporal.js";
import { checkUrl } from "../tools/url-policy.js";
import type { JournalStore } from "./journal.js";
import type { SelectionStore } from "./selections.js";
import type { StateStore } from "./state.js";

export const CopyDestinationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("window").describe("An existing window (any browser)."),
      windowId: z.string().describe("Destination window handle."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("newWindow").describe("A new window in the named browser."),
      browser: z
        .enum(["chrome", "chromium", "brave", "edge", "safari"])
        .describe("Browser to open the new window in."),
    })
    .strict(),
]);

export const CopyTabsParamsSchema = z
  .object({
    selector: z.unknown().optional(),
    selectionId: z.string().optional(),
    destination: z.unknown().describe("Validated against CopyDestinationSchema."),
    idempotencyKey: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Same key ⇒ the stored outcome is returned instead of duplicating tabs."),
  })
  .refine((v) => (v.selector === undefined) !== (v.selectionId === undefined), {
    message: "provide exactly one of selector | selectionId",
  });

export interface CopyItemResult {
  sourceTabId: string;
  url: string;
  status: "created" | "skipped" | "failed";
  createdTabId?: string | undefined;
  reason?: string | undefined;
}

export interface CopyTabsResult {
  status: "success" | "partial" | "failed";
  items: CopyItemResult[];
  warnings: string[];
  /** True when this result was replayed from a previous idempotencyKey use. */
  replayed?: boolean;
  snapshotToken?: string | undefined;
}

export interface CopyDeps {
  store: StateStore;
  journal: JournalStore;
  selections: SelectionStore;
  runCommand: (params: Record<string, unknown>) => Promise<unknown>;
  /** Idempotency memory, owned by the daemon (see makeIdempotencyCache). */
  idempotency: IdempotencyCache;
}

export interface IdempotencyCache {
  get(key: string): CopyTabsResult | undefined;
  set(key: string, result: CopyTabsResult): void;
}

export function makeIdempotencyCache(
  opts: { capacity?: number; ttlMs?: number; now?: () => number } = {},
): IdempotencyCache {
  const capacity = opts.capacity ?? 32;
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { at: number; result: CopyTabsResult }>();
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return e.result;
    },
    set(key, result) {
      entries.set(key, { at: now(), result });
      while (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
  };
}

export async function copyTabs(
  params: Record<string, unknown>,
  deps: CopyDeps,
): Promise<CopyTabsResult> {
  const input = CopyTabsParamsSchema.parse(params);
  const destination = CopyDestinationSchema.parse(input.destination);

  if (input.idempotencyKey !== undefined) {
    const prior = deps.idempotency.get(input.idempotencyKey);
    if (prior !== undefined) return { ...prior, replayed: true };
  }

  const snapshot = deps.store.getSnapshot();
  const temporal = deps.journal.temporalSnapshot();
  const domain = makeBrowserDomain(snapshot, {
    temporal: mapTemporalProvider(temporal.focused, temporal.navigated),
    focusedWindowHint: deps.journal.windowMru(1)[0]?.windowId,
  });

  let refs: BrowserRef[];
  const warnings: string[] = [];
  if (input.selector !== undefined) {
    const selector = parseSelector(input.selector);
    assertValid(selector, domain);
    const resolved = resolveSelector(selector, domain);
    refs = resolved.occurrences.map((o) => o.entity);
    warnings.push(...resolved.warnings);
  } else {
    const rec = deps.selections.get(input.selectionId as string, snapshot.snapshotToken);
    if (rec === undefined) {
      throw new Error(
        `selection "${input.selectionId}" is unknown or expired — re-run select_tabs.`,
      );
    }
    if (rec.stale) {
      throw new Error(
        `selection "${input.selectionId}" was resolved against a different snapshot — ` +
          `re-run select_tabs and copy again.`,
      );
    }
    refs = rec.keys.map((k) => domain.byKey(k)).filter((r): r is BrowserRef => r !== undefined);
  }

  const tabs = refs.filter((r): r is Extract<BrowserRef, { kind: "tab" }> => r.kind === "tab");
  if (tabs.length === 0) {
    throw new Error(
      "the selection contains no tabs — copy reconstructs tabs; project structural nodes " +
        'through "members" first.',
    );
  }
  if (tabs.length !== refs.length) {
    warnings.push(`${refs.length - tabs.length} non-tab member(s) ignored.`);
  }
  if (tabs.some((t) => t.tab.groupId !== undefined)) {
    warnings.push(
      "group membership is not recreated by copy in this version — copies arrive ungrouped.",
    );
  }

  // Destination validation up front: an unknown window must fail BEFORE any
  // tab is created, not after the first one.
  let destWindowId: string | undefined;
  let destBrowser: string;
  if (destination.kind === "window") {
    const ref = domain.byKey(destination.windowId);
    if (ref?.kind !== "window") {
      throw new Error(
        `destination window "${destination.windowId}" is not in the snapshot — re-run list_tabs.`,
      );
    }
    destWindowId = destination.windowId;
    destBrowser = ref.browser.browser;
  } else {
    destBrowser = destination.browser;
  }

  const items: CopyItemResult[] = [];
  let newWindowId: string | undefined;
  for (const t of tabs) {
    const url = t.tab.url;
    const verdict = checkUrl(url);
    if (!verdict.ok) {
      items.push({
        sourceTabId: t.tab.tabId,
        url,
        status: "skipped",
        reason: `URL scheme not reconstructable here: ${verdict.reason}`,
      });
      continue;
    }
    try {
      const targetWindow = destWindowId ?? newWindowId;
      let result: { tabId?: string; windowId?: string };
      if (targetWindow !== undefined) {
        // pinned rides the creation itself (open_tab supports it natively);
        // activate:false so a batch copy doesn't thrash the user's focus.
        result = (await deps.runCommand({
          kind: "open_tab",
          url,
          windowId: targetWindow,
          activate: false,
          pinned: t.tab.pinned === true,
        })) as typeof result;
      } else {
        // First creation into a newWindow destination goes through
        // open_window; its windowId anchors every later copy — one new
        // window per call, not per tab.
        result = (await deps.runCommand({
          kind: "open_window",
          url,
          browser: destBrowser,
        })) as typeof result;
        newWindowId = result.windowId;
        if (newWindowId === undefined) {
          warnings.push(
            "the first creation did not report its window — later copies fall back to " +
              "separate windows.",
          );
        }
        if (t.tab.pinned === true && result.tabId !== undefined) {
          await deps
            .runCommand({ kind: "tab_action", tabId: result.tabId, action: "pin" })
            .catch(() => warnings.push(`pin not re-applied on ${result.tabId}`));
        }
      }
      items.push({
        sourceTabId: t.tab.tabId,
        url,
        status: "created",
        createdTabId: result.tabId,
      });
    } catch (err) {
      items.push({
        sourceTabId: t.tab.tabId,
        url,
        status: "failed",
        reason: (err as Error).message,
      });
    }
  }

  const createdCount = items.filter((i) => i.status === "created").length;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const status: CopyTabsResult["status"] =
    failedCount === 0 && createdCount > 0 ? "success" : createdCount > 0 ? "partial" : "failed";

  const result: CopyTabsResult = {
    status,
    items,
    warnings,
    snapshotToken: snapshot.snapshotToken,
  };
  if (input.idempotencyKey !== undefined) deps.idempotency.set(input.idempotencyKey, result);
  return result;
}
