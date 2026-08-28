# Keyboard-native browser control for agents — the Surfingkeys idea

> **Status: parked idea, 2026-08-23.** Not a plan, not scoped, nothing committed to.
> Written down so it survives; George's observation, fleshed out.

## The observation

Every AI browser-control product converges on one of two action spaces:

1. **Pixels** — screenshot in, `click(x, y)` out. Claude's computer use, OpenAI's Operator,
   most of the agent-browser startups.
2. **Injected JS** — `document.querySelector(...)` + `.click()`, or a CDP/Playwright locator.

George drives his own browser a third way: **Surfingkeys**, vim-style, fully keyboard. Press
`f`, every actionable element gets a one-to-three character label, type the label, it's
clicked. He is measurably faster this way than with a mouse.

The idea: **that third way is a better action space for an agent than either of the two the
industry picked**, and it is sitting right there, mature, already installed.

## Why hints beat coordinates — the argument

A screenshot-and-coordinates loop is a *lossy round trip through pixels*. The DOM already
knows precisely which elements are actionable. That knowledge gets rasterised into an image,
and the model is then asked to infer it back out. Two lossy conversions to recover
information that was exact before the first one.

Hints skip both. Concretely:

| | coordinates | hints |
|---|---|---|
| Action space | continuous, unbounded (`x`,`y` ∈ viewport) | **discrete, enumerable** (47 labels) |
| Wrong target | clicks *something*, silently | label doesn't exist → **rejected** |
| Cost per turn | ~1–2k image tokens, often several | ~50–300 text tokens |
| Zoom / DPI / retina | must be tracked and corrected | irrelevant |
| Scroll offset | must be tracked | re-hint and it's correct |
| Reproducible in a test | brittle (pixel drift) | **exact** (`f` then `sd`) |
| Model-native | vision | **tokens** |

The second row is the one that matters most, and it is the same argument this repo spent an
entire cycle making about its own tests: **a coordinate click is dispatch-only.** It proves
a click happened somewhere. A hint activation can return *what was actually activated* —
tag, role, accessible name, `href`, bounding box — which is **effect verification**. The
worst failure mode in browser automation is the silent mis-click, and hints make it
structurally hard rather than merely unlikely.

Third argument, less obvious: **the hint set is a curated filter, not a raw dump.** Surfingkeys'
notion of "actionable" has been beaten into shape against real websites by people who use it
all day and complain when it misses something. That is a different and probably better filter
than "every node with a click handler". It encodes years of adversarial contact with real
pages.

## The visual-feedback layer — why it is step one and not polish

George's instinct that this comes first is right, and the reason is stronger than
presentation.

When a key combo fires, the extension should show it: the hint label pulses / brightens /
scales, and the element that got activated gets a distinct, brief highlight — different
treatment for *selected* vs *activated* vs *failed*.

That buys four separate things:

1. **A human can watch an agent work and understand it.** Right now watching an agent drive a
   browser is watching things happen for no visible reason. Trust comes from legibility.
2. **A recorded session becomes an artifact.** A GIF of an agent solving a task, with every
   keystroke visible, is a debugging tool and a demo at the same time.
3. **It closes the loop for the agent, not just the human.** A post-action screenshot with the
   activated element highlighted is a cheap, unambiguous confirmation that the thing addressed
   is the thing that got hit. That is the effect-verification above, made visible.
4. **It is the smallest independently useful piece.** It has value even if none of the rest
   gets built, which is the right property for a step-one.

Failure feedback matters as much as success feedback — a hint that matched nothing, or an
element that moved between hinting and activation, should look *different*, not just absent.

## How it would fit this repo

browser-tab already has most of the machinery, which is why the idea is tempting here rather
than as a greenfield thing.

Existing, reusable:

- **A proven injection path.** `packages/extension-core/src/inject.ts` does a two-step
  `chrome.scripting.executeScript` (define a file, then call a function in it) — used today
  for `extract.js`. A hint engine is the same shape: inject, call, get structured data back.
- **A command bus with a typed wire.** `ExtCommandSchema.kind` in
  `packages/shared-types/src/wire.ts:93-110` is a closed enum; adding a kind flows
  shared-types → `extension-core/commands.ts` → the daemon's `executeCommand` router.
- **A perception tool with modes.** `get_page` already has
  `metadata | text | state` (`packages/shared-types/src/page.ts:17`).
- **Cache-busting that already understands page identity.** `navEpoch`, bumped on committed
  navigation, is exactly the staleness key a hint manifest needs.
- **Screenshots that return real image blocks** for the visual confirmation loop.

The natural shape, in this repo's existing vocabulary:

```
get_page  mode: "actionable"   →  { epoch, hints: [{ label, tag, role, name, href, bbox }] }
tab_action kind: "hint"        →  { label } → { activated: { tag, role, name, href, bbox } }
```

Two additive changes to a closed enum and one new perception mode. No new subsystem.

`mode: "actionable"` is arguably the more valuable half on its own, even with no activation
command: it is a compact, token-cheap description of *what can be done on this page right now*,
which is something no current tool in the registry returns.

## The hard parts (honest list)

- **Surfingkeys is someone else's extension.** Two extensions cannot share state, and MV3
  cannot reliably dispatch trusted key events into another extension's content script. Four
  options, none free:
  - *(a) Reimplement the hint engine.* Full control, no dependency, but rebuilds something
    mature and inherits none of its site-specific hardening.
  - *(b) Vendor/fork its hint engine.* Best ratio if the licence allows — **licence not
    verified, check before relying on this.**
  - *(c) Drive the real Surfingkeys.* Fragile, and probably not possible from MV3.
  - *(d) Ask upstream for an API.* Slowest, least in our control.
  - The idea survives all four — the *action space* is the insight, not the specific extension.
- **Staleness.** A hint manifest is a snapshot. SPAs re-render between hinting and activation.
  Needs an epoch on the manifest and rejection of a stale activation, or you have reintroduced
  the silent mis-click by another route.
- **Shadow DOM, cross-origin iframes, canvas apps.** Hints degrade here. So do coordinates,
  but differently — a canvas app is *exactly* where pixels still win. This is not a universal
  replacement and shouldn't be sold as one.
- **Non-click interaction.** Hover, drag, scroll-within-a-container, text selection, precise
  input. Getting to a field is one command; typing into it is another. The full verb set is
  bigger than "click".
- **Visible-only vs whole-document hinting.** A real design decision with a real cost either
  way.
- **Detectability.** A hint overlay is a DOM mutation. Sites hostile to automation can see it.

## The strongest objection

**The accessibility tree is the obvious rival and may simply be better.** It is standardised,
exposed via CDP, already what Playwright's `getByRole` locators are built on, and it needs no
overlay or injected engine. If the goal is "a symbolic action space instead of pixels", AX is
the answer with the least new machinery.

Two honest counters, neither decisive:

1. **AX trees are frequently wrong on real sites.** Missing labels, wrong roles, div soup with
   no semantics. Surfingkeys' heuristics exist precisely because the semantic layer is
   unreliable — it is empirically "what a power user can actually reach", which is a different
   filter, tuned against the same broken web.
2. **AX gives you a node; hints give you a keystroke.** The keystroke framing is what makes the
   visual-feedback loop, the recorded session and the reproducible test natural rather than
   bolted on.

The right move is probably not to choose: **hint labels as the address space, AX metadata as the
description of what each one is.** They are complements, and the manifest sketched above already
has slots for both (`role`, `name` are AX fields).

A second objection worth recording: frontier models are being trained directly on pixels for
computer use, and that capability is improving fast. A symbolic layer could be a local optimum
that gets flattened. The counter is that cost, determinism and testability are not going away
as concerns even if capability does improve — and those are what this buys.

## If it ever gets picked up

Rough order, cheapest-useful-thing first:

1. **Visual feedback + hint rendering only.** No agent, no commands. Inject an engine, render
   labels, animate on activation, distinguish selected / activated / failed. Drivable by hand.
   Useful and demoable on its own.
2. **`get_page mode:"actionable"`.** Read-only. Returns the manifest. Still no activation. This
   is where most of the value probably is, and it is testable with no new failure modes.
3. **`tab_action kind:"hint"`** with an epoch check and a result reporting what was *actually*
   activated. This is the effect-verification piece.
4. **Only then**: the wider verb set — type-into, hover, scroll-container, select.

Each stage is independently useful and independently abandonable, which is the property that
makes a parked idea worth un-parking.

## Open questions

- Surfingkeys' licence and how much of its hint engine is separable. **Unverified.**
- Whether MV3 can host a hint engine without a persistent content script (this repo
  deliberately uses on-demand `executeScript` only — `inject.ts:3`).
- Whether the hint label alphabet should be optimised for a model rather than for human
  home-row reachability. They are not the same objective, and this may be the single most
  interesting sub-question in here.
- What a *hinted* browser session looks like as a test fixture — this is plausibly the cleanest
  way to write reproducible real-browser interaction tests, which is a live concern in this
  repo right now.
