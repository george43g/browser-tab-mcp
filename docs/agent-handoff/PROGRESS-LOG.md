# Progress log (append-only)

Newest entry LAST. Every working session appends one entry:
**date · agent · what was done · how it was verified · what's next / blocked on.**

---

## 2026-07-27 · Claude · handoff created

- Context: the Claude session hit its weekly usage limit; **Codex** covers the
  next ~2 days, then Claude resumes. Neither agent can read the other's
  private memory, so all in-flight state was consolidated into this
  `docs/agent-handoff/` directory (README, PR-D runbook, backlog, decisions,
  gotchas, this log) — nothing about this work lives outside the repo anymore.
- Repo state at handoff: `main@6b8508a`, clean tree, all green (lint 0
  warnings · typecheck · test · test:no-native · stress 25/25 · e2e-chromium).
  Cleanup pass fully merged: PR-C #14 (global bin), PR-B #15 (risk tests),
  PR-A #16 (shared-types split).
- NEXT: **PR-D** (deploy + real-world smoke) per `PRD-DEPLOY-RUNBOOK.md`.
- Blocked on: user availability for the user-gated steps (global install,
  daemon install/TCC, loading the extension, Safari/Xcode).

---

## 2026-07-29 · Claude · PR-D executed — deployed + smoked; one defect found

- **Codex never picked this up** — tree was untouched (`main@6b8508a`, handoff
  docs still uncommitted). Resumed PR-D directly.
- **Deployed.** `pnpm verify` green → `pnpm add -g <path>` → `browser-tab`
  works from anywhere; `doctor` all-clear from outside the repo with the
  **native accelerator loaded**. User decided launchd keeps running the
  workspace build, so `daemon install` was NOT run and no TCC re-prompt
  occurred (see DECISIONS).
- **Smoked in real Chrome + Safari** — all green: crown-jewel `move` returned
  the **same tabId** in the target window (true `chrome.tabs.move`, state
  preserved); `get_page --mode state` (4060 words); `act mute` (verified in the
  next snapshot); `screenshot` (582 KB jpeg, **pixels visually confirmed to be
  the right tab**); `journal` live with `source:"ext"` records; `daemon
  restart` → both extensions reconnected in **< 2s** (bar was ≲30s). Scratch
  tab cleaned up.
- **Verified how:** every claim above came from running the built global bin
  against the user's live browsers, not from tests — plus a direct
  `listCgWindows()` / `yabai -m query --windows` cross-check for the defect.
- **Three findings**, written up in `PRD-DEPLOY-RUNBOOK.md`:
  1. `cgWindowId: null` for ALL Chrome windows — bounds-based correlation is
     ambiguous under yabai tiling (identical frames). **The wm-stack join
     silently dies in exactly its target setup.** → BACKLOG item 1 (title
     tiebreaker via yabai). NOT hot-fixed, deliberately.
  2. Both browsers were running a **stale extension build** (rebuild ≠ reload)
     → `get_page` failed, `capabilities` undefined. Fixed by reload/sideload.
  3. A stale extension **silently kills journaling** (store-derived fallback is
     suppressed for "connected" browsers). → BACKLOG item 2 (version check in
     `hello`).
- Also corrected: the user **has full Xcode** — Safari extension now runs the
  real connector, not the AppleScript path (BACKLOG item 5 closed).
- NEXT: **BACKLOG item 1** — the `cgWindowId` tiebreaker, as its own PR with
  fixtures + sabotage checks.
- Still uncommitted: this `docs/agent-handoff/` directory + the `AGENTS.md`
  pointer banner. Needs a branch → PR → the user's merge word.
