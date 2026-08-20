/**
 * One function for every place a browser-sourced URL enters a record.
 *
 * Two hygiene layers compose here, and they exist for different attackers:
 *  - `sanitize` (mcp-kit) strips ANSI/OSC/control characters — terminal and
 *    log injection from a hostile page title/URL.
 *  - `redactUrlUserinfo` (shared-types) strips `user:pass@` — a LIVE
 *    credential that would otherwise ride into snapshot files, journals,
 *    history results, logs, and any agent's context window. Two router-admin
 *    tabs carrying basic-auth were found in a real 103-tab session
 *    (2026-08-20 dogfood run).
 *
 * The connector extension already redacts at its own mapper, so with a
 * current extension the credential never even reaches the daemon; this
 * daemon-side layer covers the AppleScript adapters, Safari, global history,
 * and any OLD extension bundle that predates the redaction.
 *
 * `BROWSER_TAB_KEEP_URL_USERINFO=1` disables ONLY this daemon-side layer —
 * deliberate, documented, and off by default. It cannot resurrect what a
 * current extension already stripped at source.
 */

import { sanitize } from "@george43g/mcp-kit";
import { envBool } from "@george43g/robustness";
import { redactUrlUserinfo } from "@george43g/shared-types";

export function snapshotUrl(raw: string | undefined | null): string {
  const clean = sanitize(raw) ?? "";
  if (envBool("BROWSER_TAB_KEEP_URL_USERINFO", false)) return clean;
  return redactUrlUserinfo(clean);
}
