/**
 * Temporal fields for the browser binding — adaptation-record ruling R4.
 *
 * The binding reads `lastFocusedAt`/`lastNavigatedAt` through this interface
 * only; the daemon supplies an implementation backed by the journal's
 * in-memory session state (PR-B wires it). The binding itself never opens
 * journal files — that keeps `makeBrowserDomain` pure and unit-testable.
 *
 * An absent provider (or a tab the provider has never seen) reads as
 * `undefined`, which the language's unknown policy handles: `exclude` by
 * default (§7 freeze), so `not visited within 3d` can never accidentally
 * include tabs whose visit time is simply unknown (spec §24.6).
 */

export interface TemporalProvider {
  /** Epoch ms the tab was last focused (activated), or undefined if unknown. */
  lastFocusedAt(tabId: string): number | undefined;
  /** Epoch ms of the tab's last committed navigation, or undefined if unknown. */
  lastNavigatedAt(tabId: string): number | undefined;
}

/** Provider from plain maps — test fixtures and simple daemon wiring. */
export function mapTemporalProvider(
  focused: ReadonlyMap<string, number>,
  navigated: ReadonlyMap<string, number>,
): TemporalProvider {
  return {
    lastFocusedAt: (tabId) => focused.get(tabId),
    lastNavigatedAt: (tabId) => navigated.get(tabId),
  };
}
