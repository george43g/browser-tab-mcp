/**
 * Global history orchestration — the daemon half of the `history` tool.
 *
 * Two sources, one merged result: Chrome-family browsers answer via the
 * extension's chrome.history API (`history_search` command); Safari answers via
 * the daemon's sqlite copy of History.db (opt-in). With an explicit `browser`
 * we query just that source and surface an actionable error if it's
 * unavailable; without one we merge every source that's currently reachable
 * (and return empty when none is), mirroring how `journal` degrades.
 *
 * Distinct from `journal`: that is the daemon's in-session focus/nav memory;
 * this is the browser's own persisted URL history.
 *
 * Every result carries `sources`: one entry per source this tool considered,
 * queried or not. Without it a merged query returning Chrome-only rows was
 * indistinguishable from "Safari had nothing" — which is the wrong answer when
 * the real reason is that Safari history is switched off, its extension is
 * absent, or its sqlite read failed.
 */

import { sanitize } from "@george43g/mcp-kit";
import type { BrowserId, HistoryOutput, HistoryRow, HistorySource } from "@george43g/shared-types";
import { snapshotUrl } from "../detect/url-hygiene.js";
import { readSafariHistory, safariHistoryEnabled } from "./safari-history.js";
import type { ExtensionServer } from "./ws-server.js";

const CHROME_FAMILY: readonly BrowserId[] = ["chrome", "chromium", "brave"];

type ReadSafari = (opts: {
  query?: string;
  startTime?: number;
  endTime?: number;
  maxResults: number;
}) => Promise<HistoryRow[]>;

export interface HistoryDeps {
  ext: ExtensionServer | null;
  /** Injectable Safari reader (defaults to the sqlite path) for tests. */
  readSafari?: ReadSafari;
}

interface Target {
  browser: BrowserId;
  source: "ext" | "safari";
}

/** Wire name for a target's source, as reported in `sources`. */
function sourceName(t: Target): HistorySource["source"] {
  return t.source === "safari" ? "safari-db" : "extension";
}

const EXT_UNAVAILABLE =
  "the browser-tab extension is not connected (chrome.history lives there) — install/enable it " +
  "and paste the daemon token into its options page";
const SAFARI_UNAVAILABLE =
  "Safari history is disabled — set BROWSER_TAB_SAFARI_HISTORY=1 (needs Full Disk Access; see " +
  "`browser-tab doctor`)";

/**
 * The candidate sources a merged query did NOT reach, each with its reason.
 *
 * Deliberately the full candidate set rather than only the reachable ones: the
 * entire value of `sources` is naming the source that contributed nothing and
 * saying why, which is impossible if sources that were never asked go unlisted.
 */
function unqueriedSources(targets: Target[]): HistorySource[] {
  const queried = new Set(targets.map((t) => t.browser));
  const out: HistorySource[] = CHROME_FAMILY.filter((b) => !queried.has(b)).map((browser) => ({
    browser,
    source: "extension" as const,
    status: "unavailable" as const,
    rows: 0,
    reason: EXT_UNAVAILABLE,
  }));
  // Safari is only ever unqueried in a merged call because the flag is off —
  // when it's on, resolveTargets always includes it.
  if (!queried.has("safari")) {
    out.push({
      browser: "safari",
      source: "safari-db",
      status: "unavailable",
      rows: 0,
      reason: SAFARI_UNAVAILABLE,
    });
  }
  return out;
}

function clampMax(raw: unknown): number {
  const n = typeof raw === "number" ? Math.trunc(raw) : 50;
  return Math.min(500, Math.max(1, Number.isFinite(n) ? n : 50));
}

/** Decide which sources to query, erroring only for an explicit-but-absent one. */
function resolveTargets(explicit: BrowserId | undefined, deps: HistoryDeps): Target[] {
  if (explicit) {
    if (explicit === "safari") {
      if (!safariHistoryEnabled()) {
        throw new Error(
          "Safari history is disabled. Set BROWSER_TAB_SAFARI_HISTORY=1 (needs Full Disk Access — " +
            "see `browser-tab doctor`) to enable reading Safari's History.db.",
        );
      }
      return [{ browser: "safari", source: "safari" }];
    }
    if (!deps.ext?.isConnected(explicit)) {
      throw new Error(
        `History for ${explicit} needs its browser-tab extension connected (chrome.history). ` +
          "Install/enable the extension and paste the daemon token into its options page.",
      );
    }
    return [{ browser: explicit, source: "ext" }];
  }

  // No explicit browser — merge every source that's currently reachable.
  const targets: Target[] = [];
  for (const b of CHROME_FAMILY) {
    if (deps.ext?.isConnected(b)) targets.push({ browser: b, source: "ext" });
  }
  if (safariHistoryEnabled()) targets.push({ browser: "safari", source: "safari" });
  return targets;
}

/** Normalize an extension `history_search` payload into browser-tagged rows. */
function extRows(payload: unknown, browser: BrowserId): HistoryRow[] {
  const rows = (payload as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const row = r as { url?: unknown; title?: unknown; visitTime?: unknown; visitCount?: unknown };
    const title = row.title == null ? undefined : String(row.title);
    return {
      url: snapshotUrl(String(row.url ?? "")),
      ...(title !== undefined ? { title } : {}),
      visitTime: Math.round(Number(row.visitTime ?? 0)) || 0,
      visitCount: Number(row.visitCount ?? 0) || 0,
      browser,
    };
  });
}

export async function history(
  params: Record<string, unknown>,
  deps: HistoryDeps,
): Promise<HistoryOutput> {
  const explicit = params.browser as BrowserId | undefined;
  const query = params.query as string | undefined;
  const startTime = params.startTime as number | undefined;
  const endTime = params.endTime as number | undefined;
  const maxResults = clampMax(params.maxResults);
  const readSafari = deps.readSafari ?? readSafariHistory;

  const targets = resolveTargets(explicit, deps);
  if (targets.length === 0) {
    return { rows: [], truncated: false, sources: unqueriedSources(targets) };
  }

  const readOne = async (t: Target): Promise<HistoryRow[]> => {
    if (t.source === "safari") {
      return readSafari({
        ...(query !== undefined ? { query } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        maxResults,
      });
    }
    const raw = await deps.ext?.sendCommand(t.browser, "history_search", {
      text: query ?? "",
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      maxResults,
    });
    return extRows((raw as { payload?: unknown } | undefined)?.payload, t.browser);
  };

  // A merged query must not lose every other source because one blew up — that
  // is the failure mode `sources` exists to make visible, so the error becomes
  // a reported source rather than a rejected call. An EXPLICIT browser keeps
  // throwing: there is no partial answer to degrade to, and the caller asked
  // for that one source by name.
  const settled = await Promise.allSettled(targets.map(readOne));
  if (explicit) {
    const only = settled[0];
    if (only?.status === "rejected") throw only.reason;
  }

  const rows: HistoryRow[] = [];
  const sources: HistorySource[] = [];
  for (const [i, outcome] of settled.entries()) {
    const t = targets[i] as Target;
    if (outcome.status === "fulfilled") {
      rows.push(...outcome.value);
      sources.push({
        browser: t.browser,
        source: sourceName(t),
        status: "ok",
        rows: outcome.value.length,
      });
    } else {
      // The message can carry a subprocess's stderr (sqlite3's, notably), so it
      // goes through sanitize() like any other externally-sourced text —
      // guardrail #7 — rather than straight onto the tool result.
      const raw = (outcome.reason as Error | undefined)?.message ?? String(outcome.reason);
      sources.push({
        browser: t.browser,
        source: sourceName(t),
        status: "error",
        rows: 0,
        reason: sanitize(raw, 2048) ?? "",
      });
    }
  }
  // Only a merged query reports sources it never asked; an explicit one was
  // scoped to a single source by the caller and says nothing about the rest.
  if (!explicit) sources.push(...unqueriedSources(targets));

  rows.sort((a, b) => b.visitTime - a.visitTime);
  const truncated = rows.length > maxResults;
  return { rows: rows.slice(0, maxResults), truncated, sources };
}
