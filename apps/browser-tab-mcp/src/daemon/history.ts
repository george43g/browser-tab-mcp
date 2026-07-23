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
 */

import type { BrowserId, HistoryOutput, HistoryRow } from "@george43g/shared-types";
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
      url: String(row.url ?? ""),
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
  if (targets.length === 0) return { rows: [], truncated: false };

  const perTarget = await Promise.all(
    targets.map(async (t) => {
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
    }),
  );

  const all = perTarget.flat();
  all.sort((a, b) => b.visitTime - a.visitTime);
  const truncated = all.length > maxResults;
  return { rows: all.slice(0, maxResults), truncated };
}
