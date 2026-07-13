#!/usr/bin/env node
/**
 * Bundle this MCP server as a Claude Desktop .mcpb file.
 *
 * An .mcpb is a zip archive containing a manifest.json + the runtime
 * files. Claude Desktop reads the manifest, runs the declared `mcp`
 * command, and connects via stdio. The user gets a one-click install:
 * drag the .mcpb onto the app, click "Install".
 *
 * Output: browser-tab-mcp-${version}.mcpb in this app's cwd.
 *
 * Spec: https://github.com/modelcontextprotocol/mcpb (manifest_version 0.3)
 *
 * No npm deps — uses node:fs + node:child_process + the system `zip`
 * binary (preinstalled on macOS + Linux; Windows users running this
 * script should install via `choco install zip` or run under WSL).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..");

async function main() {
  // 1. Sanity: dist/ must exist (caller should have run `pnpm build`).
  if (!existsSync(join(APP_DIR, "dist", "index.js"))) {
    throw new Error("dist/index.js missing — run `pnpm build` first.");
  }
  if (!existsSync(join(APP_DIR, "manifest.json"))) {
    throw new Error("manifest.json missing — bail.");
  }

  // 2. Read manifest + package.json. The bundled manifest_version is the
  //    spec version; the actual app version comes from package.json.
  const manifest = JSON.parse(await readFile(join(APP_DIR, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await readFile(join(APP_DIR, "package.json"), "utf8"));
  manifest.version = pkg.version;

  // 3. Stage the bundle in a tempdir so we don't leave artifacts around.
  const stage = mkdtempSync(join(tmpdir(), "mcpb-build-"));
  try {
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2));
    // Bundle dist/ — the runtime entry. node_modules are externalized in
    // vite.config.ts, so we copy them too for the host's `node` invocation.
    await cp(join(APP_DIR, "dist"), join(stage, "dist"), { recursive: true });
    if (existsSync(join(APP_DIR, "node_modules"))) {
      // For local builds, ship node_modules. Production packaging would
      // run `npm install --omit=dev --prefix <stage>` instead — fine to
      // upgrade this later.
      await cp(join(APP_DIR, "node_modules"), join(stage, "node_modules"), { recursive: true });
    }
    // Optional: ship completions + manpage so Claude Desktop users can
    // install them post-extract. Skipped if absent.
    if (existsSync(join(APP_DIR, "completions"))) {
      await cp(join(APP_DIR, "completions"), join(stage, "completions"), { recursive: true });
    }
    if (existsSync(join(APP_DIR, "man"))) {
      await cp(join(APP_DIR, "man"), join(stage, "man"), { recursive: true });
    }

    // 4. Run `zip -r <output> .` from the stage dir. The .mcpb spec says
    //    "zip archive" with no further constraints; standard zip works.
    const out = join(APP_DIR, `${manifest.name}-${manifest.version}.mcpb`);
    if (existsSync(out)) {
      await rm(out);
    }
    execFileSync("zip", ["-rq", out, "."], { cwd: stage, stdio: "inherit" });
    console.log(`✓ Built ${out}`);
    const size = (await readFile(out)).length;
    console.log(`  size: ${(size / 1024 / 1024).toFixed(2)} MB`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`✗ build-mcpb failed: ${err.message}`);
  process.exit(1);
});
