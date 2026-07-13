# Release flow

`release.yml` ships disabled. Enabling it is a deliberate, per-tool decision — not every tool cloned from this template will publish to npm.

## When to enable

Enable when:

- The tool is open-source AND
- You want versioned, semantic-release-driven npm publishes on every push to main

Don't enable when:

- The tool is private and you distribute it via internal mechanisms (GitHub Packages with auth, internal registry, container image)
- You're not ready to commit to SemVer (semantic-release derives the version from your commit messages — `fix:` = patch, `feat:` = minor, `BREAKING CHANGE:` footer = major)

## How to enable

The shipped workflow has a single trigger — `workflow_dispatch:` — so it never runs automatically; you can also fire it ad-hoc from the Actions tab to test the pipeline. To run it on every push to main:

1. **Uncomment the `push:` trigger** in `.github/workflows/release.yml`:
   ```yaml
   on:
     workflow_dispatch:
     push:
       branches: [main]
   ```
2. **Add the `NPM_TOKEN` secret** to the repo (Settings → Secrets and variables → Actions). Generate it on npmjs.com with the `Automation` token type and publish scope for your packages.
3. **Decide which packages to publish.** The starter ships `"private": true` on every workspace package. Set `"private": false` on the packages you want to publish:
   - `apps/browser-tab-mcp/package.json` — the user-facing CLI / MCP / TUI bin (most common)
   - Any `packages/*` you want reused outside this repo (typically `robustness`, `mcp-kit`, etc.)
4. **Set the `name` field** on each publishable package to match your npm scope (the starter uses `@george43g/*`; rename if you're publishing to a different scope or unscoped).
5. **Push a commit with a conventional-commits prefix** (e.g. `feat: initial release`) — semantic-release will compute the first version and publish.

## Conventional-commits cheat sheet

| Prefix | Version bump |
|--------|--------------|
| `fix:` | patch (0.0.x) |
| `feat:` | minor (0.x.0) |
| `feat!:` or footer `BREAKING CHANGE:` | major (x.0.0) |
| `chore:` / `docs:` / `style:` / `refactor:` / `test:` / `ci:` | no release |

`semantic-release` will skip the release if no commit since the last tag triggered a bump.

## Plugin chain

`.releaserc.json`:

1. `@semantic-release/commit-analyzer` — reads commit messages.
2. `@semantic-release/release-notes-generator` — builds the changelog body.
3. `@semantic-release/changelog` — writes the body to `CHANGELOG.md` (Keep-a-Changelog format).
4. `@semantic-release/npm` — `npm publish` with `tarballDir: release`.
5. `@semantic-release/github` — creates the GitHub release with the tarball attached.
6. `@semantic-release/git` — commits the bumped `package.json` + `CHANGELOG.md` with `[skip ci]` so CI doesn't loop.

## Disabling for a specific tool

If you cloned this template and decided NOT to release:

1. Delete `.github/workflows/release.yml` (or leave it disabled — `workflow_dispatch:` is the only trigger, so it never fires automatically).
2. Delete `.releaserc.json`.
3. Remove `semantic-release`-related entries from any package.json scripts.

## Monorepo multi-package release (advanced)

Semantic-release in its default config publishes one root package. If you need to release multiple packages independently:

- Use `semantic-release-monorepo` or move to `changesets` (the latter is better for monorepos but requires more manual orchestration).
- The starter's `.releaserc.json` is single-package by design. Don't over-engineer the release process until you actually have multiple consumers.
