/**
 * Brand the log directory, as a MODULE-SCOPE side effect.
 *
 * WHY THIS IS A MODULE AND NOT A LINE IN EACH ENTRY POINT
 *
 * The logger fixes its file path at the FIRST WRITE, not at configuration
 * time, and derives the directory from whatever prefix is set at that
 * instant. So anything that logs before `setLogFilePrefix` runs wins the
 * directory for the whole process lifetime, and the branding is defeated
 * silently — the logs still work, they are just in the wrong place.
 *
 * That is not hypothetical. Two separate defects reached the same shared
 * `$TMPDIR/mcp/` bucket in two different repos:
 *   - branding called too LATE (inside a function, after something logged);
 *   - branding NEVER called at all (this repo's `cli.ts`, which is the sole
 *     bin, so every subcommand landed in the shared bucket).
 *
 * The shared bucket is unattributable: several apps' events interleave, and
 * most files carry no startup record, so nothing downstream can label them by
 * service. A telemetry shipper deriving service-from-path is categorically
 * unable to read it.
 *
 * Importing this module FIRST makes the ordering correct by construction
 * rather than by luck, and it covers entry points that do not exist yet — a
 * new one gets the behaviour by importing, not by remembering a call.
 *
 * INVARIANT: this import must come BEFORE any import that can log. Keep it
 * first in the import block. `tests/log-prefix.test.ts` enforces the
 * observable outcome (no default-prefix directory) across every subcommand,
 * so a mistake here fails a test rather than shipping.
 */

import { setLogFilePrefix } from "@george43g/robustness";
import { APP_NAME } from "./meta.js";

/** The scoped package name without its `@scope/` prefix, e.g. `tmux-control-mcp`. */
export const LOG_SLUG = APP_NAME.replace(/^@[^/]+\//, "");

setLogFilePrefix(LOG_SLUG);
