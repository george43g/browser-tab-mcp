/**
 * Page content / state extraction — injected on demand into a tab via
 * chrome.scripting.executeScript (never a persistent content script).
 *
 * STUB (PR1): the real reader-mode text + page-state probe lands in the
 * "Page content & state" phase. Shipped as a built entry now so the Safari
 * Xcode project's file set is stable and only needs regenerating once. It
 * defines an idempotent global the injector will call; today it returns an
 * empty result so nothing breaks if it is injected early.
 */

declare global {
  interface Window {
    __btExtract?: (mode: string) => unknown;
  }
}

(() => {
  if (typeof window === "undefined") return;
  if (typeof window.__btExtract === "function") return; // idempotent define
  window.__btExtract = (_mode: string): unknown => ({ stub: true });
})();

export {};
