---
name: pr-review-sop
description: Mandatory security + quality SOP for reviewing pull requests against a browser-tab-mcp repo. Use whenever the user asks to review, audit, or merge a PR.
---

# PR review SOP

Use this skill whenever the user asks to review, audit, or merge a pull request in any repo cloned from `mcp-cli-starter-template`. The MCP threat model is unusual — tools execute with the user's credentials, so a malicious or naive PR can leak data or run arbitrary commands. Treat every PR as adversarial until the audit completes.

Lifted from Gmail-MCP-Server's `pr-review-sop` skill and generalized.

## 1. Read the PR before running anything

- Read the description and the linked issues.
- Read every changed file. **Do not** run the code first — read it.
- Check `git diff main...HEAD` for the full set of changes (not just what GitHub shows).

## 2. Security audit (blocking — must pass before merge)

| Check | What to look for | Why |
|-------|------------------|-----|
| Stdout hygiene | No new `console.log` / `process.stdout.write` in code paths reachable after `StdioServerTransport.connect()` | Corrupts JSON-RPC |
| Logging via robustness | All new logs go through `@george43g/robustness/logger` (info/warn/error/perf) | NDJSON correctness; ring buffer |
| Stripped untrusted content | Any tool returning user-content surfaces calls `sanitize()` | Prevents terminal corruption, ANSI injection |
| Wrapped external content | Any tool returning data sourced from outside our control wraps it with `wrapUntrusted()` | Prevents prompt injection of LLM behavior |
| UUID-gated instructions | Any embedded instructions use `wrapInstructions(text, uuid)` and require the user to echo the UUID | Authorization for follow-on actions |
| AbortSignal | All new long loops check `signal?.aborted` | Honors MCP cancellation |
| Timeout declared | New tools have a `timeoutMs` or use the default | Prevents wedged calls |
| Secrets | No new env reads of obvious secret names without going through `@george43g/secrets` | Centralized chain |
| Schema validation | All tool inputs use Zod schemas with `.describe()` on every field | LLM-readable docs + runtime safety |
| Filesystem writes | New writes are sandboxed (no `path.join(homedir, userInput)` without validation) | Path traversal |
| Shell exec | No new `execSync` / `spawn` calls with user input concatenated into the command | Command injection |
| Network | Outbound URLs are constants or come from trusted config, not from tool input | SSRF |

Any single failure blocks the merge. Comment on the PR with the specific concern and reference this skill.

## 3. Functional review

- Does it match the PR description?
- Does it have a test? (Unit OR integration OR stress, depending on layer.)
- Does it touch the dispatcher / lifecycle / transport? If yes, `pnpm stress` MUST be run locally before merge.
- Does it touch the Rust crate? If yes, `cargo test --release` + the drift-check must pass.
- Does the README reflect the change? (CI's readme-check will catch this; manually verify if the test was bypassed with `[skip-readme]`.)

## 4. Pre-merge verification

Locally:

```bash
git fetch origin
git checkout <pr-branch>
pnpm install
pnpm verify           # lint + typecheck + test + build
pnpm stress           # only if lifecycle-affecting
```

If the PR is from a fork, run in a worktree to avoid polluting your tree.

## 5. Merge

- Use `gh pr merge --squash` (default), preserving the PR title as the commit subject for semantic-release.
- Verify the commit type prefix (`feat:`, `fix:`, `chore:`, etc) is correct — semantic-release uses it for version bumping.
- Delete the branch after merge.

## 6. After merge

- Pull main locally.
- Re-run `pnpm stress` against main as a sanity check.
- If a release workflow is enabled, monitor it for ~5 minutes to catch any publish failure.

## Common red flags

- A PR that touches `@george43g/robustness/*` without an updated test
- A new MCP tool without integration tests
- Removed `signal?.aborted` checks in long loops
- New `process.env` reads that bypass `envNum`/`envStr`/`envBool`
- `// eslint-disable` or `// @ts-ignore` comments without justification in the diff
- Refactors that disable rules in `biome.json`
- Changes to `.releaserc.json` (these are infrastructure decisions; require explicit approval)
