# Release flow

**Tool: [release-please](https://github.com/googleapis/release-please) (manifest mode, `node-workspace` plugin).**
**Output: git tags + GitHub Releases + `CHANGELOG.md`. Nothing is published to npm.**

That last sentence is the design, not an omission. Versioning and distribution
are separate concerns here: this repo wants a durable answer to *"which release
is this"* without committing to a registry. release-please was chosen over
semantic-release and changesets precisely because publishing is a **job you
simply never add** rather than a plugin you have to keep disabled — the shipped
`.releaserc.json` had `@semantic-release/npm` wired in and only stayed harmless
because the whole workflow was switched off.

## How it works

Two files drive it:

| File | Role |
|---|---|
| `release-please-config.json` | What gets released, how versions are computed |
| `.release-please-manifest.json` | The last released version per path — **generated; release-please owns it** |

And one workflow, `.github/workflows/release.yml`:

1. **Every push to `main`** → release-please reads the Conventional Commits
   since the last release and opens (or updates) a single rolling **release
   PR** titled `chore: release browser-tab X.Y.Z`. That title shape is
   load-bearing: `group-pull-request-title-pattern` is pinned in
   `release-please-config.json` because the default (`chore: release main`)
   carries no component/version, and release-please cannot parse a merged PR
   it titled itself — the release is then silently skipped
   ([release-please#2712](https://github.com/googleapis/release-please/issues/2712)).
   Its diff is only:
   - `package.json` → new version
   - `apps/browser-tab-mcp/package.json` → new version (this is the one
     `--version` prints; see *Why the root path* below)
   - `CHANGELOG.md` → generated release notes
   - `.release-please-manifest.json` → new baseline
2. **Merging that PR** → the same workflow tags `vX.Y.Z` and creates the GitHub
   Release with those notes.

If no commit since the last release warrants a bump (`chore:`, `test:`,
`refactor:`, `ci:`, `style:`, `build:`), no release PR appears. That is the
intended quiet state — not a failure.

Nothing releases without a human merging the release PR.

## Conventional-commits cheat sheet

| Prefix | Version bump | In the changelog? |
|--------|--------------|---|
| `fix:` | patch (0.0.x) | yes — *Bug Fixes* |
| `feat:` | minor (0.x.0) | yes — *Features* |
| `perf:` | patch | yes — *Performance Improvements* |
| `docs:` | none | yes — *Documentation* |
| `feat!:` / `BREAKING CHANGE:` footer | **minor** while < 1.0.0, major after | yes |
| `chore:` `test:` `refactor:` `ci:` `style:` `build:` | none | hidden |

`bump-minor-pre-major: true` is set, so a breaking change before 1.0.0 bumps the
minor rather than jumping to 1.0.0. Remove that option the day this repo is
ready to promise a stable API.

This repo squash-merges with the PR title as the commit subject, so **the PR
title is the release input**. A mislabelled PR title is a mislabelled release.

## Why the root path (`"."`) and not `apps/browser-tab-mcp`

release-please filters commits by the configured package path — a package at
`apps/browser-tab-mcp` only ever sees commits that touched
`apps/browser-tab-mcp/**` (`CommitSplit` in release-please; the root path `"."`
is the documented special case that receives *all* commits).

That filtering would be wrong here. The shipped bin **bundles the workspace
packages inline** (PR #14, self-contained global bin), so a fix in
`packages/mcp-kit` or `packages/shared-types` genuinely ships inside the
released binary. Scoping the release line to the app directory would silently
swallow those changes: no bump, no changelog line, for code that is in the
artifact.

So the release line is the repo root, and `extra-files` mirrors the version
into `apps/browser-tab-mcp/package.json` — which is what `src/meta.ts` reads at
runtime for `--version` and the TUI header. Tags stay plain `vX.Y.Z`
(`include-component-in-tag: false`) because there is exactly one release line.

## What is deliberately NOT released

| Package | Why not |
|---|---|
| `@george43g/cli-kit`, `@george43g/tui-kit`, `@george43g/robustness` | Published from `mcp-cli-starter-template`, frozen here pending a migration. Releasing them from this repo would fork their version lines. |
| `@george43g/mcp-kit`, `shared-types`, `extension-core`, `test-kit`, `env-loader`, `secrets`, `tsconfig`, `biome-config`, `vitest-config` | Internal, unpublished, no external consumer to version for. They ship *inside* the bin, and the root release line already covers changes to them. |
| `@george43g/chrome-extension` | Its version is the **manifest** version — user-facing in the browser's extension list, and kept in lockstep with `public/manifest.json` by `pnpm --filter @george43g/chrome-extension run bump` (PR #21), with a build-output test that fails CI on drift. Letting release-please bump `package.json` alone would break that invariant. Bumping the connector stays a deliberate manual act. |
| `@george43g/rust-accel`, `@george43g/safari-extension` | Build inputs, not distributed artifacts. |

The `node-workspace` plugin is configured but **inert today** — its scope is the
set of release-please-managed packages (it reads the config's `packages` map,
not the pnpm workspace globs), and there is currently one. It is there so the
moment a second `release-type: node` line is added, intra-workspace dependency
ranges and dependent bumps are handled correctly instead of drifting. It is a
guard, not decoration.

## Release identity vs build identity

Two different questions, two different strings — don't merge them:

- **semver** (`0.3.1`) — *which release*. Moves only when a release PR merges.
- **build stamp** (`0.3.1+412.9721c9b.dirty.0809T1420`, `scripts/build-stamp.mjs`)
  — *which build*. Moves every commit, frozen into the bundle at build time via
  Vite `define`. This is what catches a stale extension bundle sitting in a
  browser reporting a plausible version.

The stamp is built *from* the semver, so release-please moving the semver flows
into the stamp automatically. Neither replaces the other.

"Moves every commit" only holds because the git identity is part of turbo's
cache key: `pnpm build` exports `BUILD_STAMP=$(node scripts/build-stamp.mjs
--print)` and `turbo.json` lists it in `tasks.build.env`. Without that, a
docs-only commit changes no build input, turbo replays `dist/`, and the stamp
confidently reports the *previous* commit — which is exactly the stale-bundle
failure it exists to catch. Build with `pnpm build`, not bare `turbo run build`.

## First release (historical — shipped 2026-08-09 as v1.0.0)

An earlier revision of this doc predicted `0.1.0`; that was wrong. The
*initial* release defaults to **`1.0.0`** regardless of
`bump-minor-pre-major` (that option only shapes later bumps), and 1.0.0 was
accepted. The changelog spans the full history back to the first commit —
`bootstrap-sha` was not set, deliberately.

The cut itself hit
[release-please#2712](https://github.com/googleapis/release-please/issues/2712):
PR #31 was titled with the unparseable default (`chore: release main`), so on
merge the workflow logged `PR component: undefined does not match configured
component` + `There are untagged, merged release PRs outstanding - aborting`
and cut nothing — while the version bump and changelog *did* land on `main`.
The release was completed manually (see the recovery note below) and the title
pattern pinned so it cannot recur.

## Operational notes

- **The release PR does not run CI.** GitHub deliberately does not trigger
  workflows for events raised by the default `GITHUB_TOKEN`, so the rolling
  release PR shows no checks. This is acceptable because its diff is
  version-strings + changelog, and `ci.yml` runs on the resulting push to
  `main`. If checks on the release PR are ever wanted, swap
  `token: ${{ secrets.GITHUB_TOKEN }}` for a PAT / GitHub App token.
- **Forks are excluded** via `if: github.repository == 'george43g/browser-tab-mcp'`.
- **Manual run**: the workflow also accepts `workflow_dispatch` if you need to
  re-drive it without a new push.
- **Never hand-edit `.release-please-manifest.json`** except to correct a
  genuinely wrong baseline — release-please rewrites it on every release.
- **If a merged release PR doesn't tag** (workflow green but
  `release cut: false` / "untagged, merged release PRs outstanding"), recover
  manually: `gh release create vX.Y.Z --target <merge-commit-sha>` with the
  changelog section as notes, then swap the PR's label
  `autorelease: pending` → `autorelease: tagged`. Re-run the workflow to
  confirm the abort is gone. (This is exactly how v1.0.0 was cut.)

## If npm publishing is ever wanted

Deliberately not wired. If the decision changes, it is an *additive* job in
`release.yml`, not a change to any of the above:

```yaml
  publish:
    needs: release-please
    if: needs.release-please.outputs.release_created == 'true'
    # ... checkout, pnpm install, pnpm build, npm publish with NPM_TOKEN
```

That would also require `apps/browser-tab-mcp/package.json` to carry
`"publishConfig": { "access": "public" }`, an `NPM_TOKEN` secret, and the
`id-token: write` permission if provenance is wanted. CI already proves the
tarball is well-formed (`npm pack --dry-run`). See `docs/FOLLOWUPS.md` § 2.
