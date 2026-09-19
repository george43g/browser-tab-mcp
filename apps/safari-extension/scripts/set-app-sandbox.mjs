#!/usr/bin/env node
/**
 * Set `ENABLE_APP_SANDBOX` on the CONTAINER APP target of the generated
 * Xcode project, leaving the `.appex` alone.
 *
 *   node scripts/set-app-sandbox.mjs <project.pbxproj> <YES|NO>
 *
 * Why this exists at all. The container app needs to read the daemon's unix
 * socket at `~/.browser-tab/daemon.sock` to learn what version of the
 * extension Safari is actually running. Under App Sandbox it cannot: the
 * socket is outside the app's container, and no public entitlement grants
 * `network-outbound` to a unix socket at an arbitrary path (the file-access
 * temporary exceptions cover `open`, not `connect`). Measured — see
 * apps/safari-extension/README.md § "App Sandbox".
 *
 * Why it is a script and not a `sed`. `ENABLE_APP_SANDBOX = YES;` appears in
 * FOUR build-configuration blocks: Debug and Release for the app AND for the
 * `.appex`. The appex must keep the sandbox (Safari requires it), so a global
 * substitution would break the extension.
 *
 * Why the app target is selected by ELIMINATION rather than by name. Xcode
 * 26.3's converter does not give the app the `--bundle-identifier` it was
 * passed: `convert.sh` asks for `com.george43g.browser-tab-helper` and gets
 * `com.george43g.browser-tab-helper.Extension` for the appex but
 * `com.george43g.Browser-Tab-Helper` — different case, derived from the app
 * NAME — for the app. Matching that string exactly made a fresh `convert`
 * abort. Measured 2026-09-07. So: the app is the target whose bundle
 * identifier does NOT end in `.Extension`, and finding zero (or more than
 * one) of those is an error rather than a guess.
 *
 * Why it is a value SET and not a patch. `convert.sh` and `rebuild.sh` both
 * run the overlay, and a developer may run either repeatedly. Setting a key
 * to a value is idempotent by construction; appending a block is not.
 */

import { readFileSync, writeFileSync } from "node:fs";

const [, , projectPath, value] = process.argv;

if (!projectPath || !value) {
  process.stderr.write("usage: set-app-sandbox.mjs <project.pbxproj> <YES|NO>\n");
  process.exit(2);
}
if (value !== "YES" && value !== "NO") {
  process.stderr.write(`error: value must be YES or NO, got "${value}"\n`);
  process.exit(2);
}

const original = readFileSync(projectPath, "utf8");

/** Every `buildSettings = { … };` block, as [start, end) offsets of the body. */
function buildSettingsBlocks(text) {
  const out = [];
  const opener = /buildSettings = \{/g;
  let m = opener.exec(text);
  while (m !== null) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    if (depth === 0) out.push({ start: bodyStart, end: i - 1 });
    m = opener.exec(text);
  }
  return out;
}

const bundleIdOf = (body) => body.match(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";\n]+)"?;/)?.[1] ?? null;

/** The app target: the one that is not an app extension. */
const isAppTarget = (id) => id !== null && !id.endsWith(".Extension");

const appIds = new Set(
  buildSettingsBlocks(original)
    .map((b) => bundleIdOf(original.slice(b.start, b.end)))
    .filter(isAppTarget),
);

if (appIds.size === 0) {
  process.stderr.write(
    `error: ${projectPath} has no build configuration whose PRODUCT_BUNDLE_IDENTIFIER ` +
      "is not an .Extension — cannot tell which target is the container app.\n",
  );
  process.exit(1);
}
if (appIds.size > 1) {
  process.stderr.write(
    `error: ${projectPath} has more than one non-extension target ` +
      `(${[...appIds].join(", ")}) — refusing to guess which is the container app.\n`,
  );
  process.exit(1);
}
const appId = [...appIds][0];

let changed = 0;
let matched = 0;
let text = original;

// Walk backwards so earlier offsets stay valid as we splice.
for (const block of buildSettingsBlocks(text).reverse()) {
  const body = text.slice(block.start, block.end);
  if (bundleIdOf(body) !== appId) continue;
  matched++;

  const existing = body.match(/\n\s*ENABLE_APP_SANDBOX = ([^;]*);/);
  let nextBody;
  if (existing) {
    if (existing[1] === value) continue; // already correct — idempotent no-op
    nextBody = body.replace(/(\n\s*ENABLE_APP_SANDBOX = )[^;]*(;)/, `$1${value}$2`);
  } else {
    // Any position inside the block is valid; anchor on the block's own indent.
    const indent = body.match(/\n(\s*)\S/)?.[1] ?? "\t\t\t\t";
    nextBody = `\n${indent}ENABLE_APP_SANDBOX = ${value};${body}`;
  }
  text = text.slice(0, block.start) + nextBody + text.slice(block.end);
  changed++;
}

writeFileSync(projectPath, text);
process.stdout.write(
  `    ENABLE_APP_SANDBOX = ${value} for ${appId} ` +
    `(${changed} of ${matched} configuration(s) rewritten)\n`,
);
