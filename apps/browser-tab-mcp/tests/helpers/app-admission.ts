/**
 * What an MCP app needs before this repo's guards can see it.
 *
 * Every guard in this repo was written when browser-tab was the only app, and
 * most of them fail SILENT for a second one: the surface ledger, the parity and
 * annotation contracts read browser-tab's registry only, so a new app's tools
 * were covered by nothing and nothing went red. The fix is per-app contract
 * tests (each app checks itself, with the shared checkers in
 * `@george43g/test-kit/contracts`) plus THIS: a list of what each app must
 * carry, derived from the same app set CI gates on (`scripts/lib/mcp-apps.mjs`,
 * the mcp-kit dependency marker). A third app that lacks any of it turns
 * `app-admission.contract.test.ts` red, naming the app and the missing piece.
 *
 * Pure over a repo root, so the test can drill it against a fixture repo with
 * a deliberately incomplete second app.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { mcpApps } from "../../../../scripts/lib/mcp-apps.mjs";

/**
 * The contract tests each app runs against itself. Each entry accepts any of
 * its file names: the scaffolder names the log-branding test `log-prefix`, and
 * renaming generated files would make the next upstream sync a merge.
 */
export const REQUIRED_CONTRACT_TESTS: Readonly<Record<string, readonly string[]>> = {
  "surface ledger": ["tests/surface-coverage.contract.test.ts"],
  "MCP↔CLI parity": ["tests/interface-parity.contract.test.ts"],
  "tool annotations": ["tests/tool-annotations.contract.test.ts"],
  "README tool table": ["tests/docs-integrity.contract.test.ts"],
  "log branding": ["tests/cli-log-branding.integration.test.ts", "tests/log-prefix.test.ts"],
};

/** Variables every app shares; anything else in turbo's globalEnv belongs to one app. */
const SHARED_ENV = /^(CI|NODE_ENV|COVERAGE|COVERAGE_GATE|MCP_[A-Z0-9_]+)$/;

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

export function admissionGaps(root: string): string[] {
  const gaps: string[] = [];
  const { apps } = mcpApps(root);
  if (apps.length === 0) return ["no MCP app found — the marker or the repo layout changed"];
  const appDirs = apps.map((a) => basename(a.dir));

  const ledger = readJson(join(root, "docs/surfaces/effect-coverage.json")) as {
    surfaces: { app?: string; surface: string }[];
  };
  const release = readJson(join(root, "release-please-config.json")) as {
    packages: Record<string, { "extra-files"?: { path: string }[] }>;
  };
  const releasedPaths = new Set<string>([
    ...Object.keys(release.packages),
    ...Object.values(release.packages).flatMap((p) =>
      (p["extra-files"] ?? []).map((f) => f.path.replace(/\/package\.json$/, "")),
    ),
  ]);

  for (const app of apps) {
    const dir = basename(app.dir);
    const at = (rel: string) => join(root, app.dir, rel);

    if (!ledger.surfaces.some((r) => r.app === dir)) {
      gaps.push(`${dir}: no row in docs/surfaces/effect-coverage.json has "app": "${dir}"`);
    }
    for (const [contract, files] of Object.entries(REQUIRED_CONTRACT_TESTS)) {
      if (!files.some((f) => existsSync(at(f)))) {
        gaps.push(`${dir}: no ${contract} contract test (expected ${files.join(" or ")})`);
      }
    }
    if (!existsSync(at("README.md"))) gaps.push(`${dir}: no README.md`);
    if (!existsSync(at(".usage.kdl"))) gaps.push(`${dir}: no .usage.kdl`);
    const scripts = (readJson(at("package.json")).scripts ?? {}) as Record<string, string>;
    for (const script of ["check:usage", "stress", "test"]) {
      if (!scripts[script]) gaps.push(`${dir}: package.json has no "${script}" script`);
    }
    if (!releasedPaths.has(app.dir)) {
      gaps.push(
        `${dir}: no release-please line versions it — add "${app.dir}" to ` +
          "release-please-config.json packages (or its package.json to a line's extra-files)",
      );
    }
  }

  for (const row of ledger.surfaces) {
    if (!row.app || !appDirs.includes(row.app)) {
      gaps.push(`ledger row "${row.surface}" names app "${row.app}", which is not an MCP app`);
    }
  }

  const turbo = readJson(join(root, "turbo.json")) as { globalEnv?: string[] };
  const appSpecific = (turbo.globalEnv ?? []).filter((v) => !SHARED_ENV.test(v));
  if (appSpecific.length > 0) {
    gaps.push(
      `turbo.json globalEnv holds app-specific variables (${appSpecific.join(", ")}); every ` +
        "app's cache keys on them. Move them to that app's own turbo.json task env",
    );
  }

  const ciPath = join(root, ".github/workflows/ci.yml");
  const ciSteps = existsSync(ciPath)
    ? readFileSync(ciPath, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
    : "";
  if (/--filter[=\s]+["']?[^"'\s]*\*/.test(ciSteps)) {
    gaps.push(
      "ci.yml selects packages with a glob --filter, which exits 0 when it matches nothing — " +
        "use node scripts/for-each-mcp-app.mjs",
    );
  }
  return gaps;
}
