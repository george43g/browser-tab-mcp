/**
 * On-demand injection of the page extractor (extract.js) via
 * chrome.scripting.executeScript — never a persistent content script.
 *
 * Two-step, both idempotent:
 *   1. inject extract.js (defines the guarded global `window.__btExtract`),
 *   2. call `__btExtract(mode, maxBytes)` in the page and return its result.
 *
 * Shared by the `extract_content` command and capture-on-blur. Native tab id
 * in, mode-tagged extraction object out (the daemon caches + sanitizes it).
 */

import { api } from "./runtime.js";

/** Built entry name (see chrome-extension vite ENTRIES.extract). */
export const EXTRACT_FILE = "extract.js";

/** Loose view of chrome.scripting — Safari has it 15.4+; guard before use. */
interface ScriptingLike {
  executeScript(injection: {
    target: { tabId: number };
    files?: string[];
    func?: (...args: never[]) => unknown;
    args?: unknown[];
  }): Promise<Array<{ result?: unknown }> | undefined>;
}

/** Runs in the PAGE (serialized by chrome) — must reference nothing else. */
function extractInPage(mode: string, maxBytes: number): unknown {
  const fn = (globalThis as { __btExtract?: (m: string, mb: number) => unknown }).__btExtract;
  return fn ? fn(mode, maxBytes) : null;
}

export async function injectExtract(tabId: number, mode: string, maxBytes = 0): Promise<unknown> {
  const scripting = (api as unknown as { scripting?: ScriptingLike }).scripting;
  if (!scripting?.executeScript) {
    throw new Error(
      "chrome.scripting unavailable — content extraction needs Chrome 88+ / Safari 15.4+.",
    );
  }
  // Define the global (idempotent — re-injecting is a no-op).
  await scripting.executeScript({ target: { tabId }, files: [EXTRACT_FILE] });
  const results = await scripting.executeScript({
    target: { tabId },
    func: extractInPage as (...args: never[]) => unknown,
    args: [mode, maxBytes],
  });
  return results?.[0]?.result;
}
