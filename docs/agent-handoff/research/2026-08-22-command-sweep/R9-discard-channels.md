# R9 — `discard` across browser channels: the id-swap is CONFIRMED, and the teardown is characterised

## Summary

| Environment | `discard()` returns? | Tab id changes? | Browser/context survives? |
|---|---|---|---|
| Playwright bundled Chromium, macOS | **No** — hard crash `SEGV_ACCERR` 3/3, no return value | unobservable | **No** |
| **Real Microsoft Edge, Windows (g-home-server)** | **Yes**, cleanly | **YES — 3/3** | **No** — context closes ~2s later |
| Branded Chrome, macOS | not answerable — Chrome ≥137 can't CLI-load the extension (2/2 SW timeouts) | — | — |
| Microsoft Edge, macOS | not installed on that host | — | — |

## The headline: the id-swap is now hard evidence, not an anecdote

Three independent runs on real Windows Edge, verbatim from the pane:

```
run 1: TARGET::239550782   DISCARD::returned {"id":239550786,"discarded":true,"url":"https://example.com/"}
run 2: BEFORE-ID::229934170  DISCARD::{"id":229934174,"discarded":true}
run 3: TARGET::263071999   DISCARD::{"id":263072002,"discarded":true}
```

`chrome.tabs.discard(id)` returns a tab whose `id` is **different from the one passed in**, every
time. This is the exact behaviour a fake adapter cannot model, and it had never been demonstrated
anywhere in this project before now.

## The teardown, characterised (and my first hypothesis was WRONG)

After the discard resolves, the Playwright context dies:
```
EVT::context-closed
CTX::pages=0
SW::count=0
VERDICT::STILL-LOST  TimeoutError: browserContext.waitForEvent: Timeout 8000ms exceeded while waiting for event "serviceworker"
```

**Hypothesis tested and REFUTED:** I suspected Playwright tears down a persistent context when its
last page closes, i.e. that the discard only looked fatal because the victim was the only real page.
Run 3 held a keep-alive page open (`about:blank` + `example.org` + `example.com`, discarding only
`example.com`) — **the context still died, `pages=0`**. So it is not a last-page artifact. Recording
the refutation because the surviving hypothesis is weaker than it would look without it.

## What this is NOT: a product defect

**Do not report this as "our `discard` command crashes browsers."** During the 2026-08-22 manual
sweep, `act <tab> discard` was run against George's REAL (non-automated) Edge and the browser
survived — that run is where the id-swap was first noticed. The teardown appears only in a
**Playwright-driven headless context with CDP attached**. Treat it as an automation-environment
artifact until something contradicts that.

## Consequence for the sweep suite (this is the actionable part)

`discard` **is testable**, because the assertion target — the returned tab object — is available
**before** the teardown. But it cannot share a browser with anything else.

- Put `discard` in its **own spec file** whose fixture EXPECTS the context to terminate.
- Assert on the **return value** (`returned.id !== requestedId`, `returned.discarded === true`),
  not on a post-discard `chrome.tabs.query` — that read is unreachable by construction.
- Never place a `discard` test in a shared-context describe block: it would take every sibling
  test down with it, and the failure would look like the siblings' fault.

## Cross-environment disagreement worth carrying

macOS (bundled Chromium) hard-crashes with no return value; Windows Edge returns first, then dies.
So **a developer running this locally sees a different failure from CI**, and the macOS crash looks
like a bundled-build/swiftshader artifact rather than a property of `discard`. Any plan task about
`discard` should state which environment its acceptance criteria refer to.

## Method note (for whoever repeats this)
Run on g-home-server via the `bt-windows` tmux session, scripts delivered base64→`WriteAllBytes`,
throwaway `mkdtempSync` user-data-dirs, George's real daemon and real profiles untouched. All
scratch files removed afterwards; `git status --short` on the box confirmed clean.
