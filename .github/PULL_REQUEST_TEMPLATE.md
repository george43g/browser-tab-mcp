## What

<!-- One-paragraph summary of the change. What does it do that the codebase didn't do before? -->

## Why

<!-- Motivation, linked issue, incident reference, etc. -->

## How

<!-- High-level approach. Highlight non-obvious decisions or tradeoffs. -->

## Checklist

- [ ] `pnpm verify` passes (lint + typecheck + test + build)
- [ ] `pnpm stress` passes (only if dispatcher / lifecycle / transport changed)
- [ ] README updated (or `[skip-readme]` in the title — see CONTRIBUTING)
- [ ] Added a regression test where unit-testable
- [ ] No secrets committed (`.env*` are gitignored)
- [ ] Stress harness updated for any new lifecycle-affecting tool
