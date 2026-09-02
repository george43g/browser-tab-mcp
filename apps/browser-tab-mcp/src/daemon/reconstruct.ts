/**
 * Shared resolution for the reconstructive tools (copy_tabs / cut_tabs):
 * selector-or-selectionId → tab refs, with stale selections refused,
 * structural selections rejected with the projection hint, and non-tab
 * members reported. One resolution discipline, two risk classes.
 */

import { assertValid, parseSelector, resolveSelector } from "@george43g/control-language";
import type { BrowserRef, makeBrowserDomain } from "../select/browser-domain.js";
import type { SelectionStore } from "./selections.js";

export function resolveTabSelection(
  input: { selector?: unknown; selectionId?: string | undefined },
  domain: ReturnType<typeof makeBrowserDomain>,
  selections: SelectionStore,
  snapshotToken: string | undefined,
): { tabs: Extract<BrowserRef, { kind: "tab" }>[]; warnings: string[] } {
  let refs: BrowserRef[];
  const warnings: string[] = [];
  if (input.selector !== undefined) {
    const selector = parseSelector(input.selector);
    assertValid(selector, domain);
    const resolved = resolveSelector(selector, domain);
    refs = resolved.occurrences.map((o) => o.entity);
    warnings.push(...resolved.warnings);
  } else {
    const rec = selections.get(input.selectionId as string, snapshotToken);
    if (rec === undefined) {
      throw new Error(
        `selection "${input.selectionId}" is unknown or expired — re-run select_tabs.`,
      );
    }
    if (rec.stale) {
      throw new Error(
        `selection "${input.selectionId}" was resolved against a different snapshot — ` +
          `re-run select_tabs and try again.`,
      );
    }
    refs = rec.keys.map((k) => domain.byKey(k)).filter((r): r is BrowserRef => r !== undefined);
  }

  const tabs = refs.filter((r): r is Extract<BrowserRef, { kind: "tab" }> => r.kind === "tab");
  if (tabs.length === 0) {
    throw new Error(
      "the selection contains no tabs — reconstruction acts on tabs; project structural " +
        'nodes through "members" first.',
    );
  }
  if (tabs.length !== refs.length) {
    warnings.push(`${refs.length - tabs.length} non-tab member(s) ignored.`);
  }
  return { tabs, warnings };
}
