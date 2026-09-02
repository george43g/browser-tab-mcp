/**
 * `cut_tabs` — DSL Phase 3 PR-G. Explicitly destructive reconstructive
 * transfer: the spec §9.4 sequence verbatim — create at the destination in
 * resolved order, VERIFY each creation, and close ONLY the sources whose
 * replacement exists. It stays named `cut`, never `move`, because live page
 * state is not carried (spec §9.4's naming rule).
 *
 * The authorization is SCHEMA-level (spec §16): `confirmDestruction` must be
 * literally true or the call never reaches this module. Two close policies:
 *
 * - "after-each-success" (default): each source closes right after its own
 *   replacement verifies — a mid-batch failure leaves that source (and all
 *   later ones) open.
 * - "all-before-close": every destination is created and verified FIRST;
 *   if ANY creation failed or was skipped, NO source closes (the copies
 *   remain, reported as duplicates to clean up) — the reduced-partial-
 *   transfer mode of §9.4.
 *
 * In both modes a failed CLOSE leaves a copy AND its source alive — reported
 * per-item as `close_failed` with both ids, never silently.
 */

import { z } from "zod";
import { makeBrowserDomain } from "../select/browser-domain.js";
import { mapTemporalProvider } from "../select/temporal.js";
import { checkUrl } from "../tools/url-policy.js";
import type { IdempotencyCache } from "./copy.js";
import { CopyDestinationSchema } from "./copy.js";
import type { JournalStore } from "./journal.js";
import type { OperationStore } from "./operations.js";
import { resolveTabSelection } from "./reconstruct.js";
import type { SelectionStore } from "./selections.js";
import type { StateStore } from "./state.js";

export const CutTabsParamsSchema = z
  .object({
    selector: z.unknown().optional(),
    selectionId: z.string().optional(),
    destination: z.unknown(),
    confirmDestruction: z
      .literal(true)
      .describe("Required. cut CLOSES source tabs; their live page state cannot be recovered."),
    mode: z.enum(["after-each-success", "all-before-close"]).default("after-each-success"),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .refine((v) => (v.selector === undefined) !== (v.selectionId === undefined), {
    message: "provide exactly one of selector | selectionId",
  });

export interface CutItemResult {
  sourceTabId: string;
  url: string;
  status: "transferred" | "copy_failed" | "close_failed" | "skipped";
  createdTabId?: string | undefined;
  reason?: string | undefined;
}

export interface CutTabsResult {
  status: "success" | "partial" | "failed";
  items: CutItemResult[];
  warnings: string[];
  replayed?: boolean;
  snapshotToken?: string | undefined;
}

export interface CutDeps {
  store: StateStore;
  journal: JournalStore;
  selections: SelectionStore;
  runCommand: (params: Record<string, unknown>) => Promise<unknown>;
  idempotency: IdempotencyCache;
  /** Operation journal (PR-I). Optional so focused unit tests stay small. */
  operations?: OperationStore | undefined;
}

export async function cutTabs(
  params: Record<string, unknown>,
  deps: CutDeps,
): Promise<CutTabsResult> {
  const input = CutTabsParamsSchema.parse(params);
  const destination = CopyDestinationSchema.parse(input.destination);

  if (input.idempotencyKey !== undefined) {
    const prior = deps.idempotency.get(input.idempotencyKey);
    if (prior !== undefined) return { ...(prior as unknown as CutTabsResult), replayed: true };
  }

  const snapshot = deps.store.getSnapshot();
  const temporal = deps.journal.temporalSnapshot();
  const domain = makeBrowserDomain(snapshot, {
    temporal: mapTemporalProvider(temporal.focused, temporal.navigated),
    focusedWindowHint: deps.journal.windowMru(1)[0]?.windowId,
  });
  const { tabs, warnings } = resolveTabSelection(
    { selector: input.selector, selectionId: input.selectionId },
    domain,
    deps.selections,
    snapshot.snapshotToken,
  );
  if (tabs.some((t) => t.tab.groupId !== undefined)) {
    warnings.push(
      "group membership is not recreated by cut in this version — transfers arrive ungrouped.",
    );
  }

  let destWindowId: string | undefined;
  let destBrowser: string | undefined;
  if (destination.kind === "window") {
    const ref = domain.byKey(destination.windowId);
    if (ref?.kind !== "window") {
      throw new Error(
        `destination window "${destination.windowId}" is not in the snapshot — re-run list_tabs.`,
      );
    }
    destWindowId = destination.windowId;
  } else {
    destBrowser = destination.browser;
  }

  interface Created {
    sourceTabId: string;
    url: string;
    createdTabId?: string | undefined;
  }
  const items: CutItemResult[] = [];
  const pendingClose: Created[] = [];
  let newWindowId: string | undefined;
  let anyCreateFailed = false;

  const closeSource = async (c: Created): Promise<void> => {
    try {
      await deps.runCommand({ kind: "close_tab", tabId: c.sourceTabId });
      items.push({
        sourceTabId: c.sourceTabId,
        url: c.url,
        status: "transferred",
        createdTabId: c.createdTabId,
      });
    } catch (err) {
      items.push({
        sourceTabId: c.sourceTabId,
        url: c.url,
        status: "close_failed",
        createdTabId: c.createdTabId,
        reason: `replacement ${c.createdTabId ?? "?"} exists but the source did not close: ${
          (err as Error).message
        }`,
      });
    }
  };

  for (const t of tabs) {
    const url = t.tab.url;
    const verdict = checkUrl(url);
    if (!verdict.ok) {
      // Non-reconstructable ⇒ the source MUST survive (nothing replaces it).
      items.push({
        sourceTabId: t.tab.tabId,
        url,
        status: "skipped",
        reason: `URL scheme not reconstructable — source left open: ${verdict.reason}`,
      });
      anyCreateFailed = true;
      continue;
    }
    try {
      const targetWindow = destWindowId ?? newWindowId;
      let result: { tabId?: string; windowId?: string };
      if (targetWindow !== undefined) {
        result = (await deps.runCommand({
          kind: "open_tab",
          url,
          windowId: targetWindow,
          activate: false,
          pinned: t.tab.pinned === true,
        })) as typeof result;
      } else {
        result = (await deps.runCommand({
          kind: "open_window",
          url,
          browser: destBrowser,
        })) as typeof result;
        newWindowId = result.windowId;
      }
      // Verification: the creation pathway's settled result must name the
      // new tab. No id ⇒ not verified ⇒ the source does NOT close (§9.4).
      if (result.tabId === undefined) {
        items.push({
          sourceTabId: t.tab.tabId,
          url,
          status: "copy_failed",
          reason: "creation reported no tab id — unverified, source left open.",
        });
        anyCreateFailed = true;
        continue;
      }
      const created: Created = { sourceTabId: t.tab.tabId, url, createdTabId: result.tabId };
      if (input.mode === "after-each-success") {
        await closeSource(created);
      } else {
        pendingClose.push(created);
      }
    } catch (err) {
      items.push({
        sourceTabId: t.tab.tabId,
        url,
        status: "copy_failed",
        reason: `${(err as Error).message} — source left open.`,
      });
      anyCreateFailed = true;
    }
  }

  if (input.mode === "all-before-close") {
    if (anyCreateFailed) {
      for (const c of pendingClose) {
        items.push({
          sourceTabId: c.sourceTabId,
          url: c.url,
          status: "close_failed",
          createdTabId: c.createdTabId,
          reason:
            "all-before-close: another creation failed, so NO source was closed — the copy " +
            "remains as a duplicate to keep or clean up.",
        });
      }
      warnings.push(
        "all-before-close held every closure because at least one creation did not verify.",
      );
    } else {
      for (const c of pendingClose) await closeSource(c);
    }
  }

  const transferred = items.filter((i) => i.status === "transferred").length;
  const clean = items.every((i) => i.status === "transferred");
  const status: CutTabsResult["status"] = clean
    ? "success"
    : transferred > 0
      ? "partial"
      : "failed";

  const result: CutTabsResult = {
    status,
    items,
    warnings,
    snapshotToken: snapshot.snapshotToken,
  };
  if (input.idempotencyKey !== undefined) {
    deps.idempotency.set(input.idempotencyKey, result as never);
  }
  // §15: cut cannot restore lost live page state even if URLs reopen — the
  // undo record says so EXPLICITLY instead of leaving an executor to imply a
  // restoration it cannot perform (restoration vs reconstructive compensation).
  deps.operations?.record({
    tool: "cut_tabs",
    status,
    ...(input.selectionId !== undefined ? { selectionId: input.selectionId } : {}),
    request: input,
    outcomes: items,
    snapshotTokenBefore: snapshot.snapshotToken,
    undo: {
      kind: "unrecoverable",
      liveStateUnrecoverable: true,
      closedSourceUrls: items.flatMap((i) => (i.status === "transferred" ? [i.url] : [])),
    },
  });
  return result;
}
