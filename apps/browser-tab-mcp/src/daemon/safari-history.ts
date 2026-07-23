/**
 * Safari global history — read Safari's own persisted history without a
 * WebExtension (Safari has no chrome.history API). We copy History.db and its
 * WAL sidecars to a private tmpdir (never touch the live DB Safari holds open)
 * and query the copy with `/usr/bin/sqlite3 -json`.
 *
 * Opt-in behind BROWSER_TAB_SAFARI_HISTORY — reading History.db needs Full
 * Disk Access, which the launchd daemon's context may not share with your
 * terminal (`doctor` warns about the split). Experimental for Safari.
 *
 * Injection-free by construction: the SQL carries only integer-coerced time
 * bounds and a numeric LIMIT — never any user string. The text filter is
 * applied to the returned rows in TypeScript, never in SQL. The sqlite binary
 * and DB path are env-overridable so tests can point them at fakes/fixtures.
 */

import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { envBool } from "@george43g/robustness";
import type { HistoryRow } from "@george43g/shared-types";

const execFileP = promisify(execFile);

/** Seconds between the Unix epoch (1970-01-01) and the Cocoa/CFAbsoluteTime
 *  epoch (2001-01-01) — Safari stores visit_time in Cocoa seconds. */
export const COCOA_EPOCH_OFFSET_S = 978_307_200;

/** When a text filter is present, over-fetch then filter+slice in TS (SQL
 *  can't see the filter), so the LIMIT doesn't drop matching rows early. */
const SAFARI_TEXT_OVERFETCH = 2000;

/** Cocoa absolute seconds → Unix epoch ms. */
export function cocoaToUnixMs(cocoaSeconds: number): number {
  return Math.round((cocoaSeconds + COCOA_EPOCH_OFFSET_S) * 1000);
}

/** Unix epoch ms → Cocoa absolute seconds (for SQL time bounds). */
export function unixMsToCocoa(ms: number): number {
  return ms / 1000 - COCOA_EPOCH_OFFSET_S;
}

/** Coerce to a finite integer or throw — the injection guard for SQL literals. */
function safeInt(n: number): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) throw new Error(`non-finite numeric SQL bound: ${n}`);
  return v;
}

/** Reading History.db is opt-in — it exposes the user's full browsing history. */
export function safariHistoryEnabled(): boolean {
  return envBool("BROWSER_TAB_SAFARI_HISTORY", false);
}

function sqliteBin(): string {
  return process.env.BROWSER_TAB_SQLITE_BIN ?? "/usr/bin/sqlite3";
}

export function safariHistoryDbPath(): string {
  return (
    process.env.BROWSER_TAB_SAFARI_HISTORY_DB ?? join(homedir(), "Library", "Safari", "History.db")
  );
}

/**
 * Build the aggregation query. Only integer-coerced literals reach the SQL —
 * `startCocoa`/`endCocoa` are numeric time bounds, `limit` is numeric. No user
 * string is ever interpolated (the text filter runs on the rows in TS).
 */
export function buildHistorySql(bounds: {
  startCocoa: number | null;
  endCocoa: number | null;
  limit: number;
}): string {
  const conds: string[] = [];
  if (bounds.startCocoa !== null) conds.push(`hv.visit_time >= ${safeInt(bounds.startCocoa)}`);
  if (bounds.endCocoa !== null) conds.push(`hv.visit_time <= ${safeInt(bounds.endCocoa)}`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.max(1, safeInt(bounds.limit));
  return (
    "SELECT hi.url AS url, hv.title AS title, " +
    "MAX(hv.visit_time) AS visit_time, COUNT(hv.id) AS visit_count " +
    "FROM history_items hi JOIN history_visits hv ON hv.history_item = hi.id " +
    `${where} GROUP BY hi.id ORDER BY visit_time DESC LIMIT ${limit};`
  );
}

interface RawRow {
  url?: unknown;
  title?: unknown;
  visit_time?: unknown;
  visit_count?: unknown;
}

/** Copy History.db (+ its -wal/-shm sidecars if present) into a fresh tmpdir. */
function copyDbToTmp(src: string): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "browser-tab-safari-hist-"));
  const db = join(dir, basename(src));
  copyFileSync(src, db); // throws ENOENT/EACCES → caller maps to an FDA hint
  for (const suffix of ["-wal", "-shm"]) {
    try {
      copyFileSync(`${src}${suffix}`, `${db}${suffix}`);
    } catch {
      // sidecar absent (checkpointed) — fine, the main db is authoritative
    }
  }
  return { dir, db };
}

/**
 * Read Safari history. Copies the DB, runs the numeric-bounded query, converts
 * Cocoa visit times to epoch ms, then applies the text filter and the result
 * cap in TypeScript. Every row is tagged `browser:"safari"`.
 */
export async function readSafariHistory(opts: {
  query?: string;
  startTime?: number;
  endTime?: number;
  maxResults: number;
}): Promise<HistoryRow[]> {
  const query = opts.query?.trim() ? opts.query.trim().toLowerCase() : null;
  const sqlLimit = query ? SAFARI_TEXT_OVERFETCH : opts.maxResults;
  const sql = buildHistorySql({
    startCocoa: opts.startTime !== undefined ? unixMsToCocoa(opts.startTime) : null,
    endCocoa: opts.endTime !== undefined ? unixMsToCocoa(opts.endTime) : null,
    limit: sqlLimit,
  });

  let tmp: { dir: string; db: string } | null = null;
  try {
    tmp = copyDbToTmp(safariHistoryDbPath());
  } catch (err) {
    throw new Error(
      `Can't read Safari's History.db (${(err as Error).message}). Grant Full Disk Access to the ` +
        "binary running browser-tab (your terminal / node, or the launchd daemon) in System " +
        "Settings → Privacy & Security → Full Disk Access, then retry. See `browser-tab doctor`.",
    );
  }

  try {
    const { stdout } = await execFileP(sqliteBin(), ["-json", tmp.db, sql]);
    const rows = parseRows(stdout);
    const filtered = query
      ? rows.filter(
          (r) =>
            r.url.toLowerCase().includes(query) || (r.title ?? "").toLowerCase().includes(query),
        )
      : rows;
    return filtered.slice(0, opts.maxResults);
  } catch (err) {
    // A sqlite failure here is almost always a permissions/format issue.
    throw new Error(
      `Reading Safari history failed (${(err as Error).message}). This usually means Full Disk ` +
        "Access isn't granted to the binary running browser-tab. See `browser-tab doctor`.",
    );
  } finally {
    rmSync(tmp.dir, { recursive: true, force: true });
  }
}

/** Parse `sqlite3 -json` output (empty string when there are no rows). */
function parseRows(stdout: string): HistoryRow[] {
  const text = stdout.trim();
  if (!text) return [];
  const raw = JSON.parse(text) as RawRow[];
  return raw.map((r) => {
    const title = r.title == null ? undefined : String(r.title);
    return {
      url: String(r.url ?? ""),
      ...(title !== undefined ? { title } : {}),
      visitTime: cocoaToUnixMs(Number(r.visit_time ?? 0)),
      visitCount: Number(r.visit_count ?? 0) || 0,
      browser: "safari" as const,
    };
  });
}
