# PR-D — build + global install + real-world smoke (RUNBOOK)

> **STATUS: EXECUTED 2026-07-29 (Claude). Steps 1–5 all pass.** One defect
> found and NOT fixed here — `cgWindowId` is null for every Chrome window under
> yabai tiling (see "Findings" below; filed as BACKLOG item 1). Everything else
> is green. No code changes were needed to deploy.

Original plan: the last workstream of the cleanup pass (C #14 → B #15 → A #16
all merged), mostly a user-in-the-loop deploy.

## Findings (2026-07-29) — read these first

**1. `cgWindowId: null` for every Chrome window — DEFECT, unfixed.**
`correlateSnapshot` (`src/detect/correlate.ts`) matches CG windows by
`(ownerPid, bounds±2px)` and deliberately returns `null` when more than one
candidate matches ("never a guess"). Under yabai, all three Chrome windows are
tiled to the *identical* frame `{x:40,y:50,w:1996,h:1269}`, and the three real
Chrome CG windows share that frame too → 3 matches per window → null every
time. Safari resolved fine (`cgWindowId: 248`) **only because it had a single
window**. Net: the headline wm-stack join silently degrades to null in exactly
the tiling setup it was built for. Evidence captured 2026-07-29:

```
snap w:chrome:x523239065 {40,50,1996,1269} -> null   cg 542247 {40,50,1996,1269}
snap w:chrome:x523239254 {40,50,1996,1269} -> null   cg 349035 {40,50,1996,1269}
snap w:chrome:x523239461 {40,50,1996,1269} -> null   cg 382150 {40,50,1996,1269}
```

Fix direction (BACKLOG item 1): yabai already reports a **unique title per
window** for those same ids, so a title tiebreaker applied only to the
ambiguous subset resolves all three — no new TCC permission, since yabai is
already correlation tier 2. (`kCGWindowName` would need Screen Recording;
prefer yabai.)

**2. A stale unpacked extension is invisible until something breaks.**
Chrome started 25 Jul 04:07; the bundle was rebuilt 26 Jul 12:13. Unpacked
extensions do **not** hot-reload, so both browsers ran pre-v2 connector code
while still reporting `extensionConnected: true`. Symptoms: `get_page` failed
with `unknown command kind "extract_content"`, and `capabilities` was
`undefined` for chrome/safari (AppleScript-backed Brave had a full map).
Resolved by reloading the extension (Chrome) / `sideload` (Safari).

**3. A stale extension silently kills the journal.** Because Chrome counted as
`extensionConnected`, the AppleScript-derived event fallback was correctly
suppressed (`ingestStoreEvent` only fires for `!extensionConnected` browsers) —
but the old extension emitted no `event` frames either, so journaling stopped
entirely. The journal held ONE record, from ~26 Jul, `source: "applescript"`.
After the reload it immediately produced `source: "ext"` records. **A
capable-looking-but-incapable extension creates a total blind spot** — worth a
staleness/version check in the `hello` handshake (BACKLOG).

## 1. Build + global install ✅

- [x] `pnpm verify` on `main` — green (11/11 turbo tasks).
- [x] `pnpm add -g <abs path to apps/browser-tab-mcp>`.
- [x] `which browser-tab` → `/Users/george/Library/pnpm/browser-tab`;
      `browser-tab --version` → `0.0.0`.

**Two gotchas hit:**
- `pnpm add -g .` first failed with *"configured global bin directory
  /Users/george/Library/pnpm is not in PATH"*. The user's interactive zsh has
  it (via `.zshenv`), but the agent tool-shell drops the bare `$PNPM_HOME`
  entry. Workaround: prefix the command — `PATH="$PNPM_HOME:$PATH" pnpm add -g …`.
- pnpm **linked** the package rather than copying it
  (`+ @george43g/browser-tab-mcp 0.0.0 <- ../../../../repos/…`). Consequence:
  the global bin resolves the workspace, so **the native `.node` IS loaded** and
  nothing degrades. This also means the global CLI tracks the repo — a rebuild
  updates it instantly, and moving/deleting the repo breaks it. The
  self-contained-copy property from PR-C is therefore *not* exercised by this
  install (it was separately proven clean-room in PR-C).

## 2. Doctor + daemon ✅ (no `daemon install` — by user decision)

- [x] **DECISION 2026-07-29 (user):** keep launchd on the **workspace build**;
      do NOT repoint it at the global bin. Rationale: retains the native tier
      and the existing Automation TCC grant → no re-prompt, no `-1743` risk.
      Cost: after a rebuild you must `browser-tab daemon restart`.
- [x] `browser-tab doctor` run from **outside** the repo → *"Doctor: all
      clear"*, Node v24.15.0, **Rust accelerator loaded**, Chrome + Safari
      Automation granted, `CG window correlation — native`.
- [x] `browser-tab daemon status` → launchd running, contractVersion 2,
      wsPort 8790, correlationTier `native`, 2 displays.
- The TCC re-grant trap did **not** fire (we never changed the daemon's binary
  path). It still applies if you later run `daemon install`.

## 3. Extension + token ✅

- [x] Token at `~/.browser-tab/extension-token` still valid — **no re-paste
      needed** after reloading the extension.
- [x] Chrome: extension reloaded from `apps/chrome-extension/dist`.
- [x] Safari: `pnpm --filter @george43g/safari-extension sideload` →
      `** BUILD SUCCEEDED **`. **The user has full Xcode** — the old assumption
      ("CLT only", BACKLOG item 5) was wrong. Safari then needs the GUI step:
      Settings → Extensions → toggle the extension OFF then ON.
- [x] Post-reload both browsers report full capabilities
      (`contentExtraction`/`captureVisibleTab`/`focusEvents` all true).

## 4. Smoke ✅ (all in real Chrome)

- [x] `list` → chrome `dataSource:"extension"`, `t:chrome:x…` / `w:chrome:x…`
      handles. **`cgWindowId` null — see Finding 1.** (Safari: 248 ✅.)
- [x] **Move preserves tab identity (crown jewel).** `open` a scratch tab in
      `w:chrome:x523239461` → `move` to `w:chrome:x523239254` returned the
      **same** `tabId t:chrome:x523239753` at index 9. Same identity ⇒ a true
      `chrome.tabs.move`, not the state-losing close+reopen path.
- [x] `get_page --mode state` → `wordCount: 4060`, `scrollY: 0`,
      `dirtyForms: 3`, `navEpoch: 0`.
- [x] `act <tab> mute` → snapshot then showed `muted: true`.
- [x] `screenshot <tab>` → 582 KB jpeg + MCP image block. **Visually verified
      the pixels are the right tab** (the preflight legitimately passed because
      the tab was its window's active tab — worth checking, since a broken
      preflight would silently return a *different* tab's image).
- [x] `journal --view recent` → live `source:"ext"` window-focus + tab-focus
      records with url/title (after the reload; see Finding 3).
- [x] `daemon restart` → **both extensions reconnected in < 2s** (bar was ≲30s).
- [x] Scratch tab closed; no residue left in the user's browser.

## 5. Safari ✅ (no longer Xcode-blocked)

Safari now runs the real extension (`extensionConnected: true`, full
capabilities) — it is no longer limited to the AppleScript path. Note yabai did
**not** list the Safari window in `query --windows`, so Safari would not
correlate under tier-2; it works today only via the native tier.

## Done when — MET

Steps 1–5 pass in real Chrome + Safari, results recorded above, PROGRESS-LOG
entry appended, and the one surfaced defect is filed as BACKLOG item 1
(cgWindowId tiebreaker) rather than hot-fixed — it changes the correlation core
and deserves its own PR with unit tests.
