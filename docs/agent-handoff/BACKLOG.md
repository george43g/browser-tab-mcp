# Backlog — deferred tasks, parked ideas, open questions

Ordered roughly by priority. Strike items (with a date) when they land; move
genuine decisions into DECISIONS.md.

## Queue

0. ~~**PR-D — deploy + real-world smoke.**~~ **DONE 2026-07-29** — all steps
   pass; results + three findings recorded in `PRD-DEPLOY-RUNBOOK.md`. No code
   change was needed to deploy.

1. ~~**`cgWindowId` tiebreaker for tiled windows**~~ — **DONE 2026-08-03,
   PR #18 (awaiting merge word).** Shipped exactly as sketched below: yabai
   titles break ties on the ambiguous subset only, tiered matching
   (exact → prefix/suffix → containment), null on tie/no-titles, duplicate
   claims dropped, native tier borrows yabai titles lazily behind
   `hasAmbiguousBoundsMatch`, `correlateSnapshot` stayed pure. Live-verified:
   all three tiled Chrome windows resolve. One caveat below was WRONG —
   yabai did list Safari this session (see GOTCHAS). Original item:
   Found during PR-D smoke: `correlateSnapshot`
   (`src/detect/correlate.ts`) matches CG windows on `(ownerPid, bounds±2px)`
   and returns `null` on ambiguity. Under yabai every same-space Chrome window
   shares one frame, so **all three Chrome windows resolved to `null`** — the
   wm-stack join silently dies in exactly the setup it exists for. Safari only
   worked because it had one window. This blocks BACKLOG item 2 (wm-stack
   rewire) from being useful for Chrome.
   - Fix direction: yabai's `query --windows` already returns a **unique
     `title` per window** for the same ids it reports frames for. Apply a
     title tiebreaker *only to the ambiguous subset*, so the fast bounds path
     is unchanged when it's already unique. Snapshot titles are a prefix of
     yabai titles (yabai appends `" - Google Chrome - <profile>"`) → match by
     prefix/normalized-contains, and still return `null` if titles tie too.
   - Prefer yabai over `kCGWindowName`: window names via CGWindowList need
     **Screen Recording** TCC, yabai needs none extra (it's already tier 2).
   - Caveat found: yabai did **not** list the Safari window at all, so the
     tiebreaker must degrade to today's behaviour when yabai has no row.
   - Keep `correlateSnapshot` a pure function (it's unit-tested) — pass the
     titled rows in as an argument; add fixtures for: unique-bounds (unchanged),
     ambiguous-bounds + unique titles (resolves), ambiguous + tied titles
     (stays null), no-yabai (stays null). Sabotage-check each.

2. **Extension staleness is undetectable — add a version/protocol check to
   `hello`.** PR-D burned real time on this: both browsers ran a connector
   build from before the v2 commands while reporting `extensionConnected:
   true`. Newer command kinds failed with a raw pass-through error (`unknown
   command kind "extract_content"`), `capabilities` came back `undefined`, and
   **journaling stopped entirely** (the AppleScript event fallback is correctly
   suppressed for extension-connected browsers, but the stale extension emitted
   no events either). Suggested: extension sends its build version/protocol
   revision in `hello`; the daemon warns loudly (and `doctor` surfaces it) when
   it's older than the daemon's own; default `capabilities` to a conservative
   map instead of leaving it `undefined`, since consumers gate on that map.

2. **wm-stack rewire** (separate repo `~/dotfiles/wm-stack`) — the highest-payoff
   remaining task, out of scope for this repo but next in line after PR-D.
   Consume `browser-tab list --json` or the unix socket; join on `cgWindowId`,
   never window titles; `move` requires the daemon + a connected extension.
   Call-site inventory: `docs/HANDOFF.md` § "Immediate next steps"
   (sketchybar plugins, select-window.lua, modal_modes.lua, spaces_modal +
   dashboard adapters, collect_stats.sh, storage.lua, deferred reorg.lua).
   Migration crib: bottom of `docs/WM_STACK_CONTRACT.md`.

3. **`COVERAGE_GATE=1` flip** — the dormant half of the two-flag coverage
   design. Measured failing 2026-07-24: cli-kit 26% / robustness 58% /
   secrets 73% vs the shared 80/70/70/70 bar → needs test-writing first.
   Best done as a ratchet (arm per-package as suites mature), not a big-bang
   flip. Context: `docs/FOLLOWUPS.md` §1 (P2).

4. **Native module on the global install** — **ANSWERED 2026-07-29, no longer
   urgent.** The user chose to keep launchd on the workspace build, and
   `pnpm add -g <path>` turned out to **link** rather than copy, so the global
   bin resolves the workspace and loads the native `.node` anyway (`doctor`
   from outside the repo reports the accelerator loaded). Still worth doing if
   the bin is ever installed from a tarball/registry: ship the arch `.node` in
   package `files` + add an installed-location resolution candidate in
   `apps/browser-tab-mcp/src/native-bridge.ts`.

5. ~~**Safari extension packaging**~~ — **UNBLOCKED/DONE 2026-07-29.** The user
   **has full Xcode** (the "CLT only" assumption was wrong).
   `pnpm --filter @george43g/safari-extension sideload` → `BUILD SUCCEEDED`,
   and Safari now runs the real extension (`extensionConnected: true`, full
   capabilities) rather than the AppleScript path. Remaining manual step after
   each sideload: Safari → Settings → Extensions → toggle OFF then ON.
   Open sub-item: yabai does **not** list the Safari window in
   `query --windows`, so Safari can't correlate under tier 2 (native only).

6. **npm release enablement** — deliberately OFF until the user wants to
   distribute beyond this machine. Full plan: `docs/FOLLOWUPS.md` §2 (publish
   only the bin package; `NPM_TOKEN` secret; uncomment the `release.yml`
   trigger; semantic-release dry-run first).

7. **Optional polish** (from `docs/HANDOFF.md`):
   - Safari background-*page* 30-min idle soak — confirm it stays connected or
     reconnects (AppleScript fallback exists regardless).
   - Chrome SW-kill reconnect check (`chrome://serviceworker-internals`) —
     should reconnect <30s via the alarms watchdog.

8. **Doc fix:** `AGENTS.md` § "MCP best practices" item 2 says to declare
   timeouts in `TOOL_TIMEOUTS_MS` in `src/tools/registry.ts` — PR-B recon
   (2026-07-26) found **that constant does not exist** (tools ride the
   `withTimeout` default). Fix the doc. Edit `AGENTS.md` (source);
   `CLAUDE.md`/`.cursorrules` are symlinks to it.

## Parked ideas (deliberate "no for now")

- TUI `o` open-URL prompt — skipped; `browser-tab open <url>` covers it and
  ink text input wasn't worth the complexity.
- Safari-only manifest to silence Chrome's harmless "requires MV2" warning
  about `background.scripts` — not worth a convert + re-sign cycle.
- Mobile Safari — deferred by explicit user decision.
- Merging this repo with wm-stack into one monorepo — decided against for now
  (`docs/FOLLOWUPS.md` §3): the JSON/socket contract is the deliberate seam.
  Revisit only if 3+ interdependent tools need atomic cross-cutting changes;
  then prefer mise-as-orchestrator over Nx/Bazel.

## Open questions for the user

- ~~Native-on-global~~ — **answered 2026-07-29**: daemon stays on the workspace
  build; the global bin is linked, so native loads anyway (queue item 4).
- ~~Install full Xcode for Safari packaging~~ — **answered 2026-07-29**: Xcode
  is installed, Safari extension is live (queue item 5).
- When to start the COVERAGE_GATE ratchet (queue item 3)?
- When (if ever soon) to enable `release.yml` / npm publish (queue item 6)?
- Does the `cgWindowId` tiebreaker (queue item 1) need to preserve *stable*
  ids across a re-tile, or is per-snapshot correctness enough? (Titles change
  as the user navigates; ids must stay right, not stay constant.)
