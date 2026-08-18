# Decision log

Append-only. Each entry: date · decision · why. Never rewrite old entries —
if a decision is reversed, append the reversal.

- **2026-07-19 · Daemon + connector-extension architecture.** Research
  conclusion (don't re-derive): AppleScript alone cannot state-preserving-move
  Chromium tabs; Safari has no stable AppleScript tab ids (synthetic
  `t:safari:w<win>:i<idx>` handles instead); Safari Web Extensions can't be
  distributed outside the App Store but personal Xcode builds work fine.
  Hence: osascript polling baseline + extension for live events/true moves.

- **2026-07-19 · No AI in-tool.** browser-tab is a perception/actuation API;
  the consumer AI interprets. `annotate` exists as a cache substrate for a
  consumer's own notes — never generates content itself.

- **2026-07-20 · Merge authority = socket liveness, NOT snapshot age.** The
  extension pushes snapshots only on events (no heartbeat); age-gating made an
  idle-but-connected browser silently revert to AppleScript handles and routed
  `move` down the state-losing path. Never re-gate the merge on snapshot age.
  (`AGENTS.md` § "Extension–daemon merge".)

- **2026-07-21 · Own repo + JSON/socket contract seam** (vs merging into a
  wm-stack monorepo). The stack is polyglot; the language-agnostic contract is
  the feature. Full rationale + revisit condition: `docs/FOLLOWUPS.md` §3.

- **2026-07-22 · Contract v2 rules.** New tab/window fields are
  additive-optional — NO `version` bump for them. Capabilities are
  runtime-probed (extension `hello` / static AppleScript map), never
  hardcoded by browser name. Enrichment fields are single-authored in
  `TabEnrichmentSchema` + copied via `pickEnrichment` (field-parity tests
  go red if a mapper drops one).

- **2026-07-23 · `history` is a separate tool from `journal`.** Durable
  browser URL history vs session focus-memory — different lifetimes, different
  sources; merging them would conflate cache-busting and recall semantics.

- **2026-07-25 · Cleanup pass order C→B→A→D** (user override of the proposed
  A→B→C→D): "I don't want to refactor after deploying… because I'll need to
  deploy again after" — all code work first, deploy exactly once. B before A
  so the risk tests are a safety net under the shared-types split.

- **2026-07-25 · Scope locks for the cleanup pass** (user choices):
  A = shared-types split + lint ONLY (daemon/index.ts, adapters, cli.ts stay —
  they're cohesive modules, not barrels). B = 5 risk targets;
  `COVERAGE_GATE` stays OFF.

- **2026-07-25 · Global bin does NOT ship the native `.node`** (PR-C).
  Accepted degradation: correlation falls to tier-2 yabai, which preserves the
  cgWindowId join; only z-order/display-targeting/screencap-preflight degrade.
  Restoring native on global installs is a parked follow-up (BACKLOG item 4).

- **2026-07-26 · PR-B tests live in `tests/`, not colocated `src/`** so a
  tests-only PR doesn't trip the readme-check CI gate. (General taxonomy in
  `AGENTS.md` still applies to future tests.)

- **Standing workflow (user-set, applies to all future work):** one PR per
  workstream · each independently green · squash-merge with a
  conventional-commit title · **merge only on the user's explicit say-so** ·
  signed commits (1Password SSH).

- **2026-07-29 · launchd daemon stays on the WORKSPACE build** (user choice
  during PR-D; `daemon install` deliberately NOT run). Keeps the native
  correlation tier and the Automation TCC grant already given to that binary
  path — no re-prompt, no `-1743` risk. Cost: `browser-tab daemon restart`
  after every rebuild. The global bin was installed for CLI convenience and,
  because `pnpm add -g <path>` links rather than copies, it loads native too.

- **2026-07-29 · The `cgWindowId` tiling defect gets its own PR, not a hot-fix
  during PR-D.** It changes the correlation core (a pure, unit-tested
  function) and needs fixtures + sabotage checks; bundling it into a deploy
  checklist would have shipped an untested guess. Filed as BACKLOG item 1.

- **2026-07-27 · Handoff docs live in-repo** (`docs/agent-handoff/`), not in
  agent memory — multiple agents (Claude ↔ Codex) rotate on this work and
  cannot read each other's memory.

- **2026-08-09 · `focus_tab` is not responsible for window visibility.** User
  ruling: its job is to make the selected tab active in its window. Whether the
  window is visible, focused, minimised, on another Space or another monitor is
  **the window manager's concern**. browser-tab's obligation is to *return
  enough state* (`cgWindowId`, window state) that the caller can act. Evidence
  it is sufficient: a scratch window's `cgWindowId: 140001` resolved in yabai to
  `display:1, space:4` — yabai already indexes the exact id browser-tab emits,
  so no yabai actuation belongs in this tool. `raiseWindow` is nonetheless
  added defaulting to **true**: it is rare to want a focused tab left in a
  minimised window, so the WM-owned part becomes explicit and opt-*out* rather
  than a behaviour change.

- **2026-08-09 · Kit packages are frozen in this repo; fixes go upstream.**
  `@george43g/{cli-kit,tui-kit,robustness}` are now published from
  `mcp-cli-starter-template`. Patching the workspace copies would diverge from
  npm and be lost on migration, so defects are written to
  `UPSTREAM-KIT-BRIEF.md` for that repo's agent and browser-tab waits for a
  publish. Consequence accepted by the user: **the REPL stays broken** (`raw`
  unusable, 15/18 tools uncallable) until `cli-kit@0.2.0` lands. Verified the
  published `cli-kit@0.1.0` contains the same defect, so migrating first would
  not have helped.

- **2026-08-09 · Build identity is separate from semver.** Semver only moves on
  release, so it cannot distinguish two builds *between* releases — which is how
  a rebuilt-but-never-reloaded extension keeps reporting a plausible version
  (hit twice in one session). Every artifact now carries
  `<semver>+<count>.<sha>[.dirty.<ts>]`. The counter is `git rev-list --count
  HEAD` rather than a committed counter file: history *is* the home that
  survives clean checkouts and agrees between a laptop and CI instead of
  colliding. A dirty build of the same commit counts as a MATCH — flagging it
  would cry wolf every dev iteration; the source revision is what matters.

- **2026-08-09 · release-please for semver automation** (user choice over
  changesets / semantic-release-minus-npm / release-it). Decisive property: it
  separates versioning from publishing — a rolling Release PR does versions +
  CHANGELOG + tags + GitHub Releases, and the npm publish step is simply a job
  you never add. The existing `.releaserc.json` is orphaned (semantic-release
  is not even a dependency) and gets retired.

- **2026-08-09 · CLI gets human-readable output; the MCP text block stays JSON.**
  `mcp-kit`'s `dispatch.ts` text block is the MCP *protocol* surface and must
  remain `JSON.stringify(result)`. Human rendering therefore lives only in the
  CLI's `printResult`, which already receives `structuredContent`. (`toContent`
  is for media blocks — it is not the hook for this.)

- **2026-08-09 · release-please over semantic-release/changesets (PR-F).**
  User wanted "git tags, releases, changelogs done properly" but explicitly
  **not coupled to npm publishing**. release-please wins because publishing is
  a job you simply **never add**, rather than a plugin you must keep disabled
  — the deleted `.releaserc.json` had `@semantic-release/npm` wired in and was
  only harmless because the whole workflow was switched off. Adding an npm
  publish step is now an explicit, reviewable decision (flagged as a red flag
  in the pr-review-sop skill), not a default.

- **2026-08-09 · The release line is the repo ROOT (`"."`), app-only, not
  per-package.** release-please filters commits by package path, so a line at
  `apps/browser-tab-mcp` would ignore commits touching `packages/*` — which is
  wrong here, because the bin **bundles those packages inline** (PR #14) and
  they genuinely ship in the artifact. Root path gets all commits;
  `extra-files` mirrors the version into `apps/browser-tab-mcp/package.json`
  (what `--version` reads). Per-package release lines were rejected:
  `cli-kit`/`tui-kit`/`robustness` are published from
  `mcp-cli-starter-template` and frozen here, the rest are internal and
  unpublished, and the **connector extension must stay manually bumped**
  because its `package.json` is locked to `public/manifest.json` by a
  build-output test.

- **2026-08-09 · `node-workspace` plugin is configured but INERT today.** Its
  scope is the set of release-please-managed packages (it reads the config's
  `packages` map, NOT the pnpm workspace globs — verified by reading
  release-please 17.11.1's `buildAllPackages`), and there is currently one. It
  is kept as a guard so that the moment a second `release-type: node` line is
  added, intra-workspace dependency ranges and dependent bumps are handled
  instead of drifting. Do not "clean it up" as dead config.

- **2026-08-09 · Release semver and the build stamp stay separate axes.**
  `scripts/build-stamp.mjs` (PR #24) answers "which build is running"; semver
  answers "which release". The stamp is derived FROM the semver, so
  release-please moving the version flows through automatically. Neither
  replaces the other — don't collapse them.

## 2026-08-09 (session close)

- **Repo setting changed: GitHub Actions may create PRs.**
  `can_approve_pull_request_reviews: true` set via API (default token perms
  left at `read`) — release-please cannot open its release PR without it; the
  first run failed on exactly this. Reversible in Settings → Actions → General.
- **Squash-title types are release surface now.** PR-D was authored as
  `refactor(focus):` but adds API surface (a new input + four result fields);
  merged as `feat(focus):` so release-please bumps and sections it correctly.
  Rule going forward: pick the squash prefix for what the change IS to a
  consumer, not what it felt like to write.
- **`set_window` root cause (attempt 4, live-verified):** geometry sent to a
  non-normal window is applied asynchronously and re-asserts the captured
  state — so ordering can never fix it. The rule is `ensureRestored()` before
  any geometry. Two retracted claims are corrected in-code: `windows.get` is
  NOT optimistic at rest, and yabai was NOT the culprit (reproduced floating).
- **First release version is an open user decision** — release-please proposes
  `1.0.0` (initial-release default), not the predicted `0.1.0`. See BACKLOG
  § Open questions.

## 2026-08-18 — HTTP interface: yes, but opt-in and loopback-only

**Decision: ship it, off by default.** The capability audit flagged this as the
one item needing "an explicit decision, not a drive-by", because it is the first
surface that accepts connections from anything other than our own extension.

**Why ship it at all.** The standing rule is that most features should be
reachable from every interface. "Every interface" meant a unix socket with our
own NDJSON framing and a WebSocket reserved for the extension — fine for a
process that can link this codebase, unreachable from a shell script, a
Hammerspoon config, or anything that speaks HTTP and nothing else, which is most
of the wm-stack's neighbours.

**What makes it safe to turn on**, all three tested as behaviour rather than
asserted in a comment (`tests/http-interface.integration.test.ts`):

1. **Binds `127.0.0.1` explicitly, and that is not configurable.** Omitting the
   host makes Node listen on every interface — on a laptop that joins untrusted
   networks, that exposes tab contents and tool dispatch to the LAN. An operator
   who wants remote access should put a reverse proxy in front and make that
   decision consciously.
2. **Token required on every route, constant-time compared, `Authorization:
   Bearer` only.** Deliberately NOT accepted from a query string: a token in a
   URL lands in shell history, proxy logs and `ps` output, and people reach for
   `?token=` the moment it works. A missing and a wrong token get the identical
   response, because a distinct message is a probing oracle.
3. **No CORS header, to anyone.** The extension already puts this daemon next
   door to arbitrary web pages; a page that could *read* `/snapshot` would learn
   every open tab. CORS is not a request filter, so the token remains the actual
   control — but there is no reason to hand a browser the response as well.

**Why opt-in rather than a default port.** A default would mean an upgrade
silently starts listening on a machine whose owner never asked for it. There is
no default: `BROWSER_TAB_HTTP_PORT` unset means the server is never constructed.

**Tool dispatch goes through the same `callMcpTool` the CLI and MCP host use**,
so an HTTP caller cannot get different behaviour from the same tool name. That
costs one extra local socket hop (the tools reach the daemon back over its own
unix socket) in exchange for exactly one dispatch path. A second, "faster"
in-process path would be a second place for behaviour to drift.

**Backpressure is dropped, not buffered.** A stalled SSE reader gets its frame
discarded and a logged warning. An event stream is a live feed, not a queue;
buffering for a dead reader is how a long-lived daemon runs out of memory.
