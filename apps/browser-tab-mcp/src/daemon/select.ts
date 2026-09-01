/**
 * `select_tabs` daemon orchestration — DSL Phase 2 PR-B.
 *
 * validate → bind → resolve → project → materialize, all against ONE
 * `store.getSnapshot()` read (spec §6: every selector in a request resolves
 * against the same snapshot). Daemon-only: the resolution needs the merged
 * snapshot plus the journal's session temporal state, neither of which the
 * degraded osascript path has.
 *
 * Validation runs the control-language validator BEFORE any snapshot work
 * (schema + complexity limits + scope/relation/field-name checks against the
 * live domain), so a malformed selector never costs a resolution and errors
 * carry the package's JSON-path + hint shape.
 */

import { assertValid, parseSelector, resolveSelector } from "@george43g/control-language";
import { z } from "zod";
import { type BrowserRef, makeBrowserDomain } from "../select/browser-domain.js";
import { summarizeLiveMoveDomains } from "../select/domains.js";
import { mapTemporalProvider } from "../select/temporal.js";
import type { JournalStore } from "./journal.js";
import type { SelectionStore } from "./selections.js";
import type { StateStore } from "./state.js";

export const SelectTabsParamsSchema = z.object({
  selector: z.unknown().describe("control-language selector AST (validated by the package)."),
  projection: z
    .enum(["core", "ids", "count"])
    .default("core")
    .describe("core = flat tab rows; ids = handles only; count = number only."),
});

export interface SelectRow {
  tabId: string;
  windowId: string;
  browser: string;
  index: number;
  title: string;
  url: string;
  active: boolean;
  groupId?: string | undefined;
}

export interface SelectTabsResult {
  projection: "core" | "ids" | "count";
  count: number;
  rows?: SelectRow[];
  ids?: string[];
  resolution: {
    kind: string;
    selectionId: string;
    snapshotToken?: string | undefined;
    revision?: number | undefined;
    warnings: string[];
    liveMoveDomains: { domains: string[]; unknownCount: number; uniform: boolean };
  };
}

export interface SelectDeps {
  store: StateStore;
  journal: JournalStore;
  selections: SelectionStore;
}

export function selectTabs(params: Record<string, unknown>, deps: SelectDeps): SelectTabsResult {
  const input = SelectTabsParamsSchema.parse(params);
  const selector = parseSelector(input.selector);

  const snapshot = deps.store.getSnapshot();
  const temporal = deps.journal.temporalSnapshot();
  const domain = makeBrowserDomain(snapshot, {
    temporal: mapTemporalProvider(temporal.focused, temporal.navigated),
  });

  assertValid(selector, domain);
  const resolved = resolveSelector(selector, domain);

  const refs = resolved.occurrences.map((o) => o.entity);
  const keys = resolved.occurrences.map((o) => o.key);
  const record = deps.selections.materialize({
    kind: resolved.kind,
    keys,
    snapshotToken: snapshot.snapshotToken ?? "",
    warnings: [...resolved.warnings],
  });

  const base: SelectTabsResult = {
    projection: input.projection,
    count: keys.length,
    resolution: {
      kind: resolved.kind,
      selectionId: record.selectionId,
      snapshotToken: snapshot.snapshotToken,
      revision: snapshot.revision,
      warnings: [...resolved.warnings],
      liveMoveDomains: summarizeLiveMoveDomains(refs),
    },
  };
  if (input.projection === "count") return base;
  if (input.projection === "ids") return { ...base, ids: keys };
  if (resolved.kind !== "tab" && keys.length > 0) {
    // Core rows are tab-shaped. A structural selection under "core" answers
    // with ids plus a warning rather than zero rows masquerading as empty.
    base.resolution.warnings.push(
      `selection kind is "${resolved.kind}" — core rows apply to tabs; returning ids ` +
        `(project through "members" for tab rows)`,
    );
    return { ...base, ids: keys };
  }
  return { ...base, rows: refs.map(rowOf).filter((r): r is SelectRow => r !== undefined) };
}

/** Flat core row for a tab ref; non-tab kinds project their key only via `ids`. */
function rowOf(ref: BrowserRef): SelectRow | undefined {
  if (ref.kind !== "tab") return undefined;
  return {
    tabId: ref.tab.tabId,
    windowId: ref.window.windowId,
    browser: ref.browser.browser,
    index: ref.tab.index,
    title: ref.tab.title,
    url: ref.tab.url,
    active: ref.tab.active,
    groupId: ref.tab.groupId,
  };
}
