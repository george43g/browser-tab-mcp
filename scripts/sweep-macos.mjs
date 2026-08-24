#!/usr/bin/env node
/**
 * `pnpm sweep:macos` — the AppleScript tier, run where AppleScript actually is.
 *
 * WHY THIS EXISTS. `docs/surfaces/effect-coverage.json` carries 14 pathway rows
 * on `tier: "macos-local"`, and a Chromium Playwright suite cannot reach a
 * single one of them by construction: they are the `osascript` half of the
 * adapters, which only runs when NO extension is connected. Before this script
 * those 14 rows read `evidence: "pending"` — an honest admission that the code
 * driving George's browsers had never been proved to drive a browser.
 *
 * IT CAN NEVER RUN IN CI. GitHub's macOS runners have no logged-in GUI
 * session, so `tell application "Google Chrome"` cannot work there — not
 * "is flaky there", cannot. There is no workflow for this and adding one
 * would be adding a step that fails by design. `verify-macos.mjs` covers the
 * Darwin-only Rust; this covers the Darwin-only AppleScript.
 *
 * IT IS NOT WIRED TO pre-push, DELIBERATELY. A push must not spawn browser
 * windows and steal your focus. `focus_tab` and `set_window` genuinely raise
 * and move windows — there is no way to verify them that does not. Run it
 * when you are not typing.
 *
 * WHAT IT DRIVES. The BUILT bin (`apps/browser-tab-mcp/dist/cli.js`) as a real
 * subprocess, pointed at a socket path with no daemon behind it, so every call
 * takes the `daemon_unreachable_falling_back` path into the AppleScript
 * adapters. That is the pathway under test. Two checks (`journal`, `history`)
 * are daemon-only reads, so they get their own throwaway daemon on the same
 * isolated socket — never yours.
 *
 * TARGET SELECTION — the part that needed a decision. The adapter addresses
 * the app BY NAME (`tell application "Chromium"`), so a throwaway
 * `--user-data-dir` profile of the same browser gives NO isolation whatsoever:
 * the Apple Event lands in whichever instance is frontmost. Hence:
 *
 *   - Chromium family -> a DEDICATED Chromium install, and this script REFUSES
 *     TO START if Chromium is already open. `chromium.ts` drives Chrome, Brave,
 *     Chromium and Edge through identical script bodies, so verifying Chromium
 *     verifies the Chrome AppleScript path; the only per-browser difference is
 *     `spec.appName`.
 *   - Safari -> real Safari (there is only one), OPT-IN behind `--safari`, and
 *     under record/restore. `safari.ts` is a genuinely different adapter — its
 *     ids are synthetic `w<id>:i<index>` positions, its move reloads the page,
 *     it minimizes via `miniaturized` and it has no back/forward verb — so
 *     none of it is implied by the Chromium run.
 *
 * DISCIPLINE IS ENFORCED IN CODE, NOT CONVENTION. Every window this script
 * acts on must be in `owned` — a set it only ever adds to when IT created the
 * window. `assertOwned()` throws on anything else, so a bug that resolves the
 * wrong handle destroys nothing. Windows it created are closed in a `finally`,
 * and the app that was frontmost when it started is re-activated at the end.
 *
 * WHAT IT CANNOT ASSERT, stated so nobody reads more into a green run:
 *   - any DENIED TCC state. It reports the permissions it finds; it does not
 *     construct their absence (that would mean revoking your grants).
 *   - exact geometry. macOS clamps window frames to the visible display area,
 *     so bounds are asserted with a tolerance and a shrunk frame is a pass.
 *   - anything on a headless Mac, or multi-display / Spaces / Stage Manager
 *     behaviour.
 *   - `daemon install`. Registering a real LaunchAgent rewrites a developer's
 *     own service state; it is recorded as a deliberate non-run.
 *
 * Flags: --yes (skip the countdown) --safari (add the Safari phase)
 *        --real-history (read the real History.db instead of a fixture)
 *        --allow-skip (a TCC denial is a skip, not a failure)
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "apps", "browser-tab-mcp");
const BIN = join(APP, "dist", "cli.js");
const REPORT = join(APP, "sweep-macos-report.json");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

const argv = process.argv.slice(2);
const FLAG = {
  yes: argv.includes("--yes"),
  safari: argv.includes("--safari"),
  realHistory: argv.includes("--real-history"),
  allowSkip: argv.includes("--allow-skip"),
  browser: (() => {
    const i = argv.indexOf("--browser");
    return i >= 0 ? argv[i + 1] : null;
  })(),
};

/**
 * The Chromium-family stand-ins, in preference order.
 *
 * WHY A LIST RATHER THAN "Chromium". `chromium.ts` builds every script body
 * from `spec.appName` and nothing else — Chrome, Chromium, Brave and Edge run
 * character-identical AppleScript. So ANY of them proves the pathway, and the
 * only thing that matters is picking one the user is not sitting in.
 *
 * Chrome is excluded by construction and there is no flag to include it: it is
 * the browser people actually have open, `tell application "Google Chrome"`
 * cannot address one instance rather than another, and this harness minimizes
 * windows and moves them. Choosing a browser you use is not a preference this
 * script will accept.
 *
 * Homebrew's `chromium` cask is listed first but is frequently unlaunchable —
 * it ships ad-hoc signed and quarantined, fails the Gatekeeper check (brew
 * says so at install time, and deprecated it for that reason on 2026-08-24),
 * and `open` then returns -128. Brave and Edge are properly signed and are the
 * durable choices.
 */
const CFT_NAME = "Google Chrome for Testing";

/**
 * Every place `Google Chrome for Testing.app` plausibly lives, newest first.
 *
 * Playwright downloads it into its own cache and NEVER installs it into
 * /Applications, so this repo already has a scriptable, separately-named,
 * unquarantined Chromium-family browser on any machine that has run the e2e
 * suite. Finding it costs nothing and saves a 200MB install.
 */
function chromeForTestingPaths() {
  const out = [`/Applications/${CFT_NAME}.app`];
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    const versions = readdirSync(cache)
      .filter((d) => d.startsWith("chromium-"))
      // "chromium-1228" — numeric suffix, newest last, so reverse for newest first.
      .sort((a, b) => Number(b.split("-")[1] ?? 0) - Number(a.split("-")[1] ?? 0));
    for (const v of versions) {
      for (const arch of ["chrome-mac-arm64", "chrome-mac"]) {
        out.push(join(cache, v, arch, `${CFT_NAME}.app`));
      }
    }
  } catch {
    // no Playwright cache — fine, the branded browsers below still apply
  }
  return out;
}

/**
 * The Chromium-family stand-ins, in preference order.
 *
 * Chrome for Testing leads because it is the one that needs no install and no
 * decision: Google's own automation build, bundle id
 * `com.google.chrome.for.testing`, entirely distinct from `com.google.Chrome`.
 * Verified on this box 2026-08-24 — with it and real Chrome both running,
 * `tell application "Google Chrome for Testing" to count windows` returned 1
 * (its own) while `tell application "Google Chrome"` returned 2 (the user's),
 * which is the isolation this whole tier depends on.
 *
 * It reaches the adapter through BROWSER_TAB_CHROMIUM_APP_NAME, because the
 * adapter addresses browsers BY APP NAME and knows only four. That is also
 * why Playwright's own isolation does not help here: `--user-data-dir` and a
 * CDP port isolate the profile and the automation channel, and Apple Events
 * route by app identity, which neither of them touches.
 *
 * Homebrew's `chromium` cask is listed last because it is usually
 * unlaunchable: ad-hoc signed AND quarantined, so Gatekeeper blocks it and
 * `open` returns a bare `-128`. Homebrew deprecated it for that reason.
 */
const FAMILY = [
  { browser: "chromium", appName: CFT_NAME, processName: CFT_NAME, paths: chromeForTestingPaths() },
  { browser: "brave", appName: "Brave Browser", processName: "Brave Browser" },
  { browser: "edge", appName: "Microsoft Edge", processName: "Microsoft Edge" },
  { browser: "chromium", appName: "Chromium", processName: "Chromium" },
];

const say = (m) => process.stdout.write(`\n${BOLD}> ${m}${OFF}\n`);
const note = (m) => process.stdout.write(`  ${DIM}${m}${OFF}\n`);
function die(m, hint) {
  process.stderr.write(`\n${RED}FAIL: ${m}${OFF}\n${hint ? `  ${hint}\n` : ""}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Results ledger. One row per (surface, pathway) — the same shape the coverage
// ledger's `macos-local` rows point at, so a reader can line them up.
// ---------------------------------------------------------------------------
const results = [];
function record(surface, pathway, status, reason) {
  results.push({ surface, pathway, status, ...(reason ? { reason } : {}) });
  const mark =
    status === "pass"
      ? `${GREEN}pass${OFF}`
      : status === "skip"
        ? `${YELLOW}skip${OFF}`
        : `${RED}FAIL${OFF}`;
  process.stdout.write(
    `  ${mark} ${surface} ${DIM}(${pathway})${OFF}${reason ? ` — ${reason}` : ""}\n`,
  );
}

/** Run one assertion. A throw is a finding, not a crash — the sweep continues. */
async function check(surface, pathway, fn) {
  try {
    const detail = await fn();
    record(surface, pathway, "pass", detail || undefined);
    return true;
  } catch (err) {
    record(
      surface,
      pathway,
      "fail",
      (err instanceof Error ? err.message : String(err)).split("\n")[0],
    );
    return false;
  }
}

function skip(surface, pathway, reason) {
  record(surface, pathway, "skip", reason);
}

// ---------------------------------------------------------------------------
// Driving the built bin. Isolated socket => the AppleScript fallback path.
// ---------------------------------------------------------------------------
const ISO = mkdtempSync(join(tmpdir(), "browser-tab-sweep-"));
const SOCKET = join(ISO, "daemon.sock");

/** Chosen by the preflight below; every check reads it. */
let TARGET = null;

function baseEnv(browser) {
  return {
    ...process.env,
    BROWSER_TAB_SOCKET_PATH: SOCKET,
    BROWSER_TAB_STATE_DIR: join(ISO, "state"),
    BROWSER_TAB_CACHE_DIR: join(ISO, "cache"),
    MCP_LOG_DIR: join(ISO, "logs"),
    // The sweep talks to exactly one browser at a time; polling the others
    // would touch apps it has made no promise about.
    BROWSER_TAB_BROWSERS: browser,
    // Retarget the `chromium` id when the chosen stand-in is not the app the
    // adapter defaults to (Chrome for Testing, a local build). Empty string is
    // treated as unset by `retargetChromium`, so the branded browsers and
    // Safari are unaffected.
    ...(TARGET && TARGET.browser === "chromium" && TARGET.appName !== "Chromium"
      ? { BROWSER_TAB_CHROMIUM_APP_NAME: TARGET.appName }
      : {}),
    // Long enough for a first-contact TCC consent dialog to be answered.
    BROWSER_TAB_OSA_TIMEOUT_MS: "20000",
  };
}

async function bt(args, extraEnv = {}) {
  const { stdout, stderr } = await execFileP(process.execPath, [BIN, "--json", ...args], {
    env: { ...baseEnv(TARGET?.browser ?? "chromium"), ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
  }).catch((err) => {
    // Non-zero exit: the CLI writes the message to stderr and exits 1.
    const msg = (err.stderr || err.stdout || err.message || "").toString().trim();
    throw new Error(msg.replace(/\x1b\[[0-9;]*m/g, "") || `browser-tab ${args.join(" ")} failed`);
  });
  void stderr;
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

/** Like bt(), but the call is EXPECTED to fail — returns the error message. */
async function btRefuses(args, extraEnv = {}) {
  try {
    await bt(args, extraEnv);
  } catch (err) {
    // Under `--json` the CLI prints an error ENVELOPE, so err.message is a
    // block of JSON. Unwrap it: the sentence is what these checks assert on,
    // and a report full of truncated `{ "error": { "tool": …` proves nothing
    // to a reader.
    try {
      const parsed = JSON.parse(err.message);
      if (typeof parsed?.error?.message === "string") return parsed.error.message;
    } catch {
      // not JSON — the plain message is what we wanted anyway
    }
    return err.message;
  }
  throw new Error(`expected \`browser-tab ${args.join(" ")}\` to be refused, but it succeeded`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` returns truthy, or throw with the last value seen. */
async function until(label, fn, { timeoutMs = 15_000, everyMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 160)})`,
      );
    }
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------
async function stateOf(browser, env = {}) {
  const snap = await bt(["list", "--browser", browser], { BROWSER_TAB_BROWSERS: browser, ...env });
  const st = (snap.browsers ?? []).find((b) => b.browser === browser);
  if (!st) throw new Error(`snapshot carries no ${browser} entry`);
  return { snap, state: st };
}

async function windowsOf(browser, env = {}) {
  const { state } = await stateOf(browser, env);
  return state.windows ?? [];
}

async function windowById(browser, windowId, env = {}) {
  const w = (await windowsOf(browser, env)).find((x) => x.windowId === windowId);
  if (!w) throw new Error(`window ${windowId} is not in the snapshot`);
  return w;
}

// ---------------------------------------------------------------------------
// Ownership guard — the reason this script is safe to point at real Safari.
// ---------------------------------------------------------------------------
const owned = new Set();
function assertOwned(windowId) {
  if (!owned.has(windowId)) {
    throw new Error(
      `refusing to act on window ${windowId}: this sweep did not create it. ` +
        `Owned: ${[...owned].join(", ") || "(none)"}`,
    );
  }
  return windowId;
}

// ---------------------------------------------------------------------------
// AppleScript utilities used by the harness itself (not by the code under test)
// ---------------------------------------------------------------------------
async function osa(script) {
  const { stdout } = await execFileP("/usr/bin/osascript", ["-e", script], { timeout: 20_000 });
  return stdout.trim();
}

async function frontmostApp() {
  try {
    return await osa(
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
  } catch {
    return null;
  }
}

/**
 * The browser's own account of a window's minimized state, read out of band.
 *
 * WHY THIS IS NEEDED AND NOT A SHORTCUT. Neither AppleScript adapter emits a
 * window `state` field at all (`chromium.ts` readState / `safari.ts` readState
 * map windowId/bounds/focused/incognito and stop) — `state` is a v2 field the
 * EXTENSION supplies. So on this pathway the snapshot cannot tell you whether
 * a window is minimized, and a check that polled it would wait forever.
 *
 * Asking the browser directly is the same move the Chromium e2e tier makes
 * with `sw.evaluate(() => chrome.windows.get(...))`: a second, independent
 * source of truth that is not the code under test. Without it, `focus_tab`
 * would be asserting only its own return value — which is exactly the shape
 * of the mock that let bug #106 live for months.
 */
async function minimizedOf(browser, windowId) {
  const nativeId = windowId.split(":").pop();
  if (browser === "safari") {
    return (
      (await osa(
        `tell application "Safari" to get miniaturized of (first window whose id is ${nativeId})`,
      )) === "true"
    );
  }
  return (
    (await osa(
      `tell application ${JSON.stringify(TARGET.appName)} to get minimized of ` +
        `(first window whose id is ${nativeId})`,
    )) === "true"
  );
}

/**
 * Is a tiling window manager going to overrule anything we ask for?
 *
 * MEASURED, NOT ASSUMED (this box, 2026-08-24). With yabai running, a bare
 * `tell application "…" to set bounds of w to {120, 120, 1020, 820}` read back
 * as `{-1297, -1030, 563, -10}` — a different display and a different size.
 * That is yabai doing its job: it owns geometry and re-tiles the window the
 * instant the app moves it.
 *
 * So the bounds assertion is not verifiable here, and pretending otherwise
 * would mean either a permanently-red check or an assertion loosened until it
 * proves nothing. Skipping WITH THIS REASON is the honest third option — the
 * ledger stays short rather than quietly short. The minimize/normal transition
 * below is unaffected (a tiling WM does not fight `minimized`), so `set_window`
 * still gets a real effect proof.
 */
function tilingWmRunning() {
  for (const wm of ["yabai", "Amethyst", "Rectangle", "AeroSpace"]) {
    try {
      execFileSync("/usr/bin/pgrep", ["-x", wm], { stdio: "ignore" });
      return wm;
    } catch {
      // not this one
    }
  }
  return null;
}

async function isRunning(processName) {
  try {
    execFileSync("/usr/bin/pgrep", ["-x", processName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A page every check can navigate to that needs no network and no local server:
// `about:blank` is refused by the url policy, so use example.com's IANA-reserved
// domains. They resolve, and nothing here asserts on their CONTENT — only that
// the URL the browser reports back changed.
const PAGE_A = "https://example.com/";
const PAGE_B = "https://example.net/";
const PAGE_C = "https://example.org/";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
if (process.platform !== "darwin") {
  process.stdout.write(
    `sweep:macos — skipped: this is ${process.platform}, and the AppleScript tier is Darwin-only.\n`,
  );
  process.exit(0);
}

if (!existsSync(BIN)) {
  die(
    `no built bin at ${BIN}.`,
    "Run `pnpm build` — this sweep drives the SHIPPED artifact, not src/.",
  );
}

function appPath(spec) {
  for (const p of spec.paths ?? []) if (existsSync(p)) return p;
  return spec.paths?.[0] ?? `/Applications/${spec.appName}.app`;
}

/**
 * Will `open` actually launch this bundle, or will Gatekeeper refuse it?
 *
 * `spctl -a` performs the same assessment `open` does and is NON-MUTATING — it
 * reports the verdict, it grants and revokes nothing. Asking here turns a bare
 * `_LSOpenURLsWithCompletionHandler() failed ... error -128` ("user cancelled",
 * naming no cause) into a sentence with the remedy in it.
 */
function gatekeeperVerdict(spec) {
  const path = appPath(spec);
  let quarantined = false;
  try {
    quarantined = execFileSync("/usr/bin/xattr", [path], { stdio: "pipe" })
      .toString()
      .includes("com.apple.quarantine");
  } catch {
    // no xattrs at all — definitively not quarantined
  }
  // An UNQUARANTINED app launches whatever `spctl` thinks of its signature:
  // macOS only performs the assessment on quarantined bundles. Checking
  // `spctl` alone would reject Chrome for Testing, which fails assessment with
  // the same "code has no resources" message as the Homebrew chromium cask and
  // yet launches perfectly — Playwright starts it on every e2e run. Measured
  // on this box 2026-08-24; getting this backwards would have rejected the one
  // browser that actually works.
  if (!quarantined) return { ok: true };
  try {
    execFileSync("/usr/sbin/spctl", ["-a", "-t", "exec", path], { stdio: "pipe" });
    return { ok: true };
  } catch (err) {
    const detail = (err.stderr ?? "").toString().trim().split("\n").pop() || "assessment rejected";
    return { ok: false, detail, quarantined: true };
  }
}

if (FLAG.browser === "chrome") {
  die(
    "this sweep will not drive Google Chrome, and there is no flag to make it.",
    'It is the browser people actually have open; `tell application "Google Chrome"` cannot ' +
      "address one instance rather than another; and this harness minimizes windows, moves them " +
      "and steals focus. Chromium, Brave and Edge run character-identical AppleScript, so any of " +
      "them proves the same pathway.",
  );
}

const candidates = FLAG.browser ? FAMILY.filter((f) => f.browser === FLAG.browser) : FAMILY;
if (candidates.length === 0) {
  die(
    `unknown --browser "${FLAG.browser}".`,
    `Choose one of: ${FAMILY.map((f) => f.browser).join(", ")}.`,
  );
}

const rejected = [];
for (const spec of candidates) {
  if (!existsSync(appPath(spec))) {
    rejected.push(`${spec.appName}: not installed`);
    continue;
  }
  if (await isRunning(spec.processName)) {
    rejected.push(
      `${spec.appName}: already running — this sweep could not tell its windows from yours`,
    );
    continue;
  }
  const gk = gatekeeperVerdict(spec);
  if (!gk.ok) {
    rejected.push(`${spec.appName}: quarantined AND rejected by Gatekeeper (${gk.detail})`);
    continue;
  }
  TARGET = spec;
  break;
}

if (!TARGET) {
  die(
    `no usable Chromium-family browser:\n  - ${rejected.join("\n  - ")}`,
    "Quit the running one, or install a properly-signed stand-in: " +
      "`brew install --cask brave-browser` (or `microsoft-edge`). Homebrew's `chromium` cask is " +
      "ad-hoc signed and quarantined, so `open` returns -128; de-quarantining it " +
      "(`xattr -dr com.apple.quarantine /Applications/Chromium.app`) is a decision for the " +
      "machine's owner, not for this script — which is why it refuses rather than doing it for you.",
  );
}

const BROWSER = TARGET.browser;

const startedFrontmost = await frontmostApp();

say("sweep:macos — the AppleScript tier");
note(`bin        ${BIN}`);
note(`isolation  ${SOCKET} (no daemon behind it -> AppleScript fallback)`);
note(
  `target     ${TARGET.appName} (id "${BROWSER}")` +
    `${FLAG.safari ? " + Safari (real, record/restore)" : ""}`,
);
for (const r of rejected) note(`passed over ${r}`);
note(`frontmost  ${startedFrontmost ?? "(unknown)"} — restored at the end`);

if (!FLAG.yes) {
  process.stdout.write(
    `\n${YELLOW}This opens real browser windows, raises them and moves them. It WILL steal focus.${OFF}\n` +
      `${DIM}Ctrl-C now if you are mid-sentence. Starting in ${OFF}`,
  );
  for (let i = 3; i > 0; i--) {
    process.stdout.write(`${i}… `);
    await sleep(1000);
  }
  process.stdout.write("go\n");
}

let launchedChromium = false;

// ---------------------------------------------------------------------------
// Phase 1 — the Chromium-family AppleScript adapter, daemon-free
// ---------------------------------------------------------------------------
try {
  say(`${TARGET.appName} — launching (this sweep owns this instance)`);
  try {
    execFileSync("/usr/bin/open", [
      "-a",
      appPath(TARGET),
      "--args",
      "--no-first-run",
      "--no-default-browser-check",
    ]);
  } catch (err) {
    // Not a `check()` finding: with no browser there is nothing to verify, so
    // this must read as a harness failure, not a surface defect.
    die(
      `could not launch ${TARGET.appName}: ${(err.stderr ?? "").toString().trim() || err.message}`,
      "error -128 means Gatekeeper or the user cancelled the launch. Open the app once from " +
        "Finder to record an approval, or use a properly-signed browser " +
        "(`brew install --cask brave-browser`).",
    );
  }
  launchedChromium = true;
  await until(`${TARGET.appName} to be running`, () => isRunning(TARGET.processName), {
    timeoutMs: 30_000,
  });
  await sleep(1500); // let the AppleScript dictionary come up

  // --- Automation TCC. The first Apple Event to a freshly installed app pops
  // the consent dialog and osascript BLOCKS until it is answered; the long
  // BROWSER_TAB_OSA_TIMEOUT_MS above is what keeps us from killing it.
  say("Automation (TCC) — first contact may prompt; answer 'OK'");
  let tccOk = false;
  try {
    await bt(["list", "--browser", BROWSER]);
    tccOk = true;
    record("doctor", "Automation TCC probe (chromium)", "pass", "Apple Events accepted");
  } catch (err) {
    const msg = err.message;
    if (/Not authorized to send Apple events/i.test(msg)) {
      if (FLAG.allowSkip) {
        skip("doctor", "Automation TCC probe (chromium)", "permission denied (--allow-skip)");
      } else {
        record("doctor", "Automation TCC probe (chromium)", "fail", msg.split(".")[0]);
      }
    } else {
      record("doctor", "Automation TCC probe (chromium)", "fail", msg.split("\n")[0]);
    }
  }

  if (!tccOk) {
    note("Automation permission is absent — every Chromium check below is unreachable.");
    for (const s of [
      "list_tabs",
      "open_window",
      "open_tab",
      "focus_tab",
      "tab_action",
      "set_window",
      "close_tab",
      "move_tab",
      "close_window",
    ]) {
      skip(s, `${BROWSER} AppleScript`, "Automation permission denied");
    }
  } else {
    // --- open_window ------------------------------------------------------
    let winA = null;
    await check("open_window", `${BROWSER} AppleScript (\`make new window\`)`, async () => {
      const res = await bt(["window", "open", PAGE_A]);
      if (!res.windowId) throw new Error(`no windowId in result: ${JSON.stringify(res)}`);
      winA = res.windowId;
      owned.add(winA);
      const w = await until("the new window in the snapshot", async () =>
        (await windowsOf(BROWSER)).find((x) => x.windowId === winA),
      );
      if (!w.tabs?.length) throw new Error("the new window reports no tabs");
      return `${winA}, ${w.tabs.length} tab(s)`;
    });

    if (!winA) throw new Error("cannot continue the Chromium phase without a window");

    // --- list_tabs: THE handle-grammar assertion only this tier can make ---
    await check("list_tabs", `${BROWSER} AppleScript (handle grammar + dataSource)`, async () => {
      const { snap, state } = await stateOf(BROWSER);
      if (snap.source !== "osascript-direct") {
        throw new Error(
          `snapshot source is "${snap.source}", not "osascript-direct" — a daemon answered`,
        );
      }
      if (state.dataSource !== "applescript") {
        throw new Error(`dataSource is "${state.dataSource}", not "applescript"`);
      }
      const w = state.windows.find((x) => x.windowId === winA);
      const tab = w?.tabs?.[0];
      if (!tab) throw new Error("no tab to inspect");
      // Generation ids are `t:chromium:<digits>`; extension ids carry an `x`.
      if (!/^t:chromium:\d+$/.test(tab.tabId)) {
        throw new Error(`tab handle "${tab.tabId}" is not an AppleScript-generation id`);
      }
      if (!/^w:chromium:\d+$/.test(w.windowId)) {
        throw new Error(`window handle "${w.windowId}" is not an AppleScript-generation id`);
      }
      return `${tab.tabId} / ${w.windowId}`;
    });

    // --- open_tab ---------------------------------------------------------
    let tabB = null;
    await check("open_tab", `${BROWSER} AppleScript (\`make new tab\`)`, async () => {
      const before = (await windowById(BROWSER, winA)).tabs.length;
      const res = await bt(["open", PAGE_B, "--window", assertOwned(winA)]);
      if (!res.tabId) throw new Error(`no tabId in result: ${JSON.stringify(res)}`);
      tabB = res.tabId;
      const w = await until("the tab count to rise", async () => {
        const cur = await windowById(BROWSER, winA);
        return cur.tabs.length > before ? cur : null;
      });
      if (!w.tabs.some((t) => t.tabId === tabB)) {
        throw new Error(`returned handle ${tabB} is not in the window's tab list`);
      }
      return `${tabB} (${before} -> ${w.tabs.length} tabs)`;
    });

    // --- tab_action navigate / reload / back / forward ---------------------
    if (tabB) {
      await check("tab_action", `${BROWSER} AppleScript (navigate)`, async () => {
        await bt(["act", tabB, "navigate", "--url", PAGE_C]);
        const t = await until("the URL to change", async () => {
          const w = await windowById(BROWSER, winA);
          const found = w.tabs.find((x) => x.tabId === tabB);
          return found?.url?.startsWith("https://example.org") ? found : null;
        });
        return t.url;
      });

      await check("tab_action", `${BROWSER} AppleScript (reload)`, async () => {
        const res = await bt(["act", tabB, "reload"]);
        if (!res.ok) throw new Error(`reload did not report ok: ${JSON.stringify(res)}`);
        return "ok";
      });

      // back/forward exist only in the Chromium dictionary (Safari's has no
      // verb), so this is the ONLY place in the repo they meet a browser.
      //
      // THE HISTORY ENTRY IS THE WHOLE DIFFICULTY, and eight runs did not
      // fully explain it. What IS established, all measured 2026-08-24 against
      // the same build:
      //
      //   - This shape — tab born at example.net via `open_tab` (`make new tab
      //     … with properties {URL:…}`), one `navigate` on top, then `back` —
      //     is the configuration that PASSED.
      //   - Adding a settle between the birth and the navigate broke it, and
      //     it stayed broken across settles of 2s / 2.5s / 3s.
      //   - Replacing the birth entry with a second `navigate` (so the pair is
      //     `set URL` -> `set URL`) failed 3/3 attempts, even though exactly
      //     that sequence with `delay 5` INSIDE a single osascript returns the
      //     previous URL reliably.
      //
      // The mechanism is NOT understood — the difference between one osascript
      // holding a live tab reference across delays and three CLI invocations
      // resolving the tab by id each time is the obvious suspect, and it is a
      // suspicion, not a finding. Recorded as BACKLOG B20 rather than dressed
      // up. What this check therefore pins is the configuration known to work;
      // a regression in `go back` itself still turns it red.
      let wentBack = null;
      await check("tab_action", `${BROWSER} AppleScript (back)`, async () => {
        const urlNow = async () => {
          const w = await windowById(BROWSER, winA);
          return w.tabs.find((x) => x.tabId === tabB)?.url ?? "";
        };
        for (let i = 1; i <= 3 && !wentBack; i++) {
          await bt(["act", tabB, "back"]);
          wentBack = await until(
            `the URL to go back (attempt ${i}/3)`,
            async () => {
              const u = await urlNow();
              return u.startsWith("https://example.net") ? u : null;
            },
            { timeoutMs: 6000 },
          ).catch(() => null);
        }
        if (!wentBack) {
          throw new Error(
            "`go back` did not move the URL in 3 attempts. The verb itself works in isolation, " +
              "so what is unreliable is a history entry created through this tool being " +
              "reachable by a later `back` — see BACKLOG B20, where the mechanism is recorded " +
              "as NOT understood rather than guessed at.",
          );
        }
        return wentBack;
      });

      // If `back` did not move, `forward` has nothing to undo, and asserting
      // "the URL is example.org" would pass WITHOUT THE COMMAND DOING
      // ANYTHING — the URL is already example.org. That is the vacuous-pass
      // shape this repo keeps rediscovering, so it is a skip, not a pass.
      if (!wentBack) {
        skip(
          "tab_action",
          `${BROWSER} AppleScript (forward)`,
          "`back` did not move, so there is nothing to go forward to — asserting the URL here " +
            "would pass without the command having had any effect",
        );
      } else {
        await check("tab_action", `${BROWSER} AppleScript (forward)`, async () => {
          await bt(["act", tabB, "forward"]);
          const t = await until("the URL to go forward", async () => {
            const w = await windowById(BROWSER, winA);
            const found = w.tabs.find((x) => x.tabId === tabB);
            return found?.url?.startsWith("https://example.org") ? found : null;
          });
          return `${wentBack} -> ${t.url}`;
        });
      }

      // The refusal is as much a contract as the success: `applescriptCaps`
      // leaves mute/pin/discard/duplicate false, and the adapter must say so
      // in a sentence that names the fix rather than throwing a raw osascript
      // error.
      await check("tab_action", `${BROWSER} AppleScript (extension-only refusal)`, async () => {
        const msg = await btRefuses(["act", tabB, "mute"]);
        if (!/extension/i.test(msg)) {
          throw new Error(`refusal does not name the extension: ${msg}`);
        }
        return msg.slice(0, 80);
      });
    } else {
      skip("tab_action", `${BROWSER} AppleScript`, "no second tab to act on");
    }

    // --- focus_tab: the highest-value assertion in this harness ------------
    // `focus.test.ts` mocks the runOsa RETURN STRING, so it proves the decoder
    // and nothing about the script. This is the only place the ordering fix
    // (clear `minimized` BEFORE `set index to 1`) meets a real window manager.
    await check(
      "focus_tab",
      `${BROWSER} AppleScript (minimized cleared BEFORE raise)`,
      async () => {
        const w0 = await windowById(BROWSER, winA);
        const target = w0.tabs[0].tabId;

        // Precondition, established through the tool and CONFIRMED out of band.
        await bt(["window", "set", assertOwned(winA), "--state", "minimized"]);
        await until(`${TARGET.appName} to agree the window is minimized`, () =>
          minimizedOf(BROWSER, winA),
        );

        const res = await bt(["focus", target]);
        if (res.wasMinimized !== true) {
          throw new Error(`wasMinimized is ${JSON.stringify(res.wasMinimized)}, expected true`);
        }
        if (res.windowState !== "normal") {
          throw new Error(
            `windowState is ${JSON.stringify(res.windowState)} after focus — the window is ` +
              `focused but the user still cannot see it (this is bug #106's shape)`,
          );
        }
        // The command's own echo is not evidence. Ask Chromium.
        if (await minimizedOf(BROWSER, winA)) {
          throw new Error(
            "focus_tab reported windowState:normal but Chromium still says the window is " +
              "minimized — the un-minimize did not happen, or happened after the raise",
          );
        }
        return `wasMinimized=true, Chromium confirms not minimized (windowFocused=${res.windowFocused})`;
      },
    );

    // --- set_window ------------------------------------------------------
    // TWO checks, because only one of them is verifiable on a real desktop.
    //
    // The state transition IS verifiable anywhere: a tiling WM does not fight
    // `minimized`, and the browser's own answer settles it. (`focus_tab` above
    // already drives this as its precondition; asserting it here too is what
    // gives `set_window` an effect row of its own rather than borrowing one.)
    await check(`set_window`, `${BROWSER} AppleScript (minimized <-> normal)`, async () => {
      await bt(["window", "set", assertOwned(winA), "--state", "minimized"]);
      await until(`${TARGET.appName} to agree it is minimized`, () => minimizedOf(BROWSER, winA));
      await bt(["window", "set", assertOwned(winA), "--state", "normal"]);
      await until(
        `${TARGET.appName} to agree it is normal again`,
        async () => (await minimizedOf(BROWSER, winA)) === false,
      );
      return "minimized -> normal, confirmed by the browser both ways";
    });

    // Geometry is a different story — see `tilingWmRunning()` for the
    // measurement. Under a tiling WM the browser moves the window and the WM
    // moves it straight back, so there is nothing here browser-tab could get
    // right that would show up as a pass.
    const wm = tilingWmRunning();
    if (wm) {
      skip(
        "set_window",
        `${BROWSER} AppleScript (bounds)`,
        `${wm} is running and owns window geometry — it re-tiles the window immediately after ` +
          "the AppleScript `set bounds`, so no geometry assertion can distinguish a working " +
          "set_window from a broken one on this machine",
      );
    } else {
      await check(`set_window`, `${BROWSER} AppleScript (bounds, clamped)`, async () => {
        const want = { x: 120, y: 120, w: 900, h: 700 };
        await bt([
          "window",
          "set",
          assertOwned(winA),
          "--bounds",
          `${want.x},${want.y},${want.w},${want.h}`,
        ]);
        const w = await until("the bounds to change", async () => {
          const cur = await windowById(BROWSER, winA);
          return cur.bounds && Math.abs(cur.bounds.x - want.x) < 200 ? cur : null;
        });
        // macOS clamps to the visible frame (menu bar, Dock), so a SHRUNK
        // frame is a correct outcome; one that ignored us entirely is not.
        const b = w.bounds;
        const near = (a, e, tol) => Math.abs(a - e) <= tol;
        if (!near(b.x, want.x, 40) || !near(b.y, want.y, 60)) {
          throw new Error(`origin ${b.x},${b.y} is nowhere near the requested ${want.x},${want.y}`);
        }
        if (b.w > want.w + 40 || b.h > want.h + 40) {
          throw new Error(
            `frame ${b.w}x${b.h} is LARGER than the requested ${want.w}x${want.h} — not a clamp`,
          );
        }
        return `requested ${want.w}x${want.h} @${want.x},${want.y}; got ${b.w}x${b.h} @${b.x},${b.y}`;
      });
    }

    await check("set_window", `${BROWSER} AppleScript (unsupported state refusal)`, async () => {
      const msg = await btRefuses(["window", "set", assertOwned(winA), "--state", "maximized"]);
      if (!/extension/i.test(msg)) throw new Error(`refusal does not name the extension: ${msg}`);
      return msg.slice(0, 80);
    });

    // --- move_tab: a REFUSAL on this pathway, and the ledger says so -------
    // The plan predicted "Chromium close+reopen"; the adapter does no such
    // thing (`chromium.ts` moveTab throws unconditionally), because close+
    // reopen loses session state and shipping that silently would be worse
    // than refusing. Corrected here rather than asserting the plan's guess.
    if (tabB) {
      await check("move_tab", `${BROWSER} AppleScript (refuses, names the extension)`, async () => {
        const msg = await btRefuses(["move", tabB, "--new-window"]);
        if (!/extension/i.test(msg) || !/session state|scroll/i.test(msg)) {
          throw new Error(`refusal does not explain the state loss and the fix: ${msg}`);
        }
        return msg.slice(0, 90);
      });
    }

    // --- close_tab --------------------------------------------------------
    if (tabB) {
      await check("close_tab", `${BROWSER} AppleScript (\`close t\`)`, async () => {
        const before = (await windowById(BROWSER, winA)).tabs.length;
        await bt(["close", tabB]);
        const w = await until("the tab count to drop", async () => {
          const cur = await windowById(BROWSER, winA);
          return cur.tabs.length < before ? cur : null;
        });
        if (w.tabs.some((t) => t.tabId === tabB)) throw new Error("the closed tab is still listed");
        return `${before} -> ${w.tabs.length} tabs`;
      });
    }

    // --- close_window -----------------------------------------------------
    await check("close_window", `${BROWSER} AppleScript (\`close window\`)`, async () => {
      await bt(["window", "close", assertOwned(winA)]);
      await until(
        "the window to leave the snapshot",
        async () => !(await windowsOf(BROWSER)).some((x) => x.windowId === winA),
      );
      owned.delete(winA);
      return `${winA} gone`;
    });
    winA = null;
  }

  // -------------------------------------------------------------------------
  // Phase 2 — the two daemon-only reads. Same isolated socket, our own daemon.
  // -------------------------------------------------------------------------
  if (tccOk) {
    say("Daemon-only reads (throwaway daemon on the isolated socket)");
    const histFixture = join(ISO, "History.db");
    if (!FLAG.realHistory) {
      // A minimal fixture with exactly the two tables buildHistorySql joins.
      // Cocoa seconds for 2026-08-01T00:00:00Z = 1785542400 - 978307200.
      const cocoa = Math.round(Date.UTC(2026, 7, 1) / 1000) - 978_307_200;
      // Deliberately the system binary rather than BROWSER_TAB_SQLITE_BIN: that
      // override exists so tests can point the DAEMON at a canned-output fake,
      // and a fake cannot CREATE a database. The daemon under test still reads
      // whatever the override says — this is only the fixture's author.
      execFileSync("/usr/bin/sqlite3", [histFixture], {
        input:
          "CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT NOT NULL);" +
          "CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL, " +
          "visit_time REAL NOT NULL, title TEXT);" +
          "INSERT INTO history_items VALUES (1, 'https://example.com/sweep-fixture');" +
          `INSERT INTO history_visits VALUES (1, 1, ${cocoa}, 'sweep fixture page');`,
      });
    }

    const daemonEnv = {
      ...baseEnv(BROWSER),
      BROWSER_TAB_WS_PORT: "27431", // never the default — yours keeps 24680
      BROWSER_TAB_POLL_MS: "700",
      BROWSER_TAB_SAFARI_HISTORY: "1",
      ...(FLAG.realHistory ? {} : { BROWSER_TAB_SAFARI_HISTORY_DB: histFixture }),
    };
    const daemon = spawn(process.execPath, [BIN, "daemon", "run"], {
      env: daemonEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let daemonErr = "";
    daemon.stderr.on("data", (d) => {
      daemonErr += d.toString();
    });

    let daemonUp = false;
    try {
      await until(
        "the throwaway daemon to answer",
        async () => {
          const st = await bt(["daemon", "status"], daemonEnv);
          return st.reachable === true ? st : null;
        },
        { timeoutMs: 25_000 },
      );
      daemonUp = true;
    } catch (err) {
      // Distinguished from a surface finding on purpose: with no daemon these
      // three were never ATTEMPTED, and saying so is the difference between a
      // report that is short and one that is quietly short.
      const why = `${err.message} ${daemonErr.slice(0, 160)}`.trim();
      for (const s2 of ["history", "journal", "screenshot"]) {
        record(s2, "daemon-only read", "fail", `throwaway daemon never came up: ${why}`);
      }
    }

    if (daemonUp) {
      // --- history: the Safari sqlite pathway, no Safari involved ---------
      await check(
        "history",
        FLAG.realHistory
          ? "safari sqlite (real History.db, needs FDA)"
          : "safari sqlite (fixture History.db)",
        async () => {
          const res = await bt(["history", "--browser", "safari", "--limit", "10"], daemonEnv);
          const src = (res.sources ?? []).find((s) => s.browser === "safari");
          if (!src) throw new Error(`no safari entry in sources: ${JSON.stringify(res.sources)}`);
          if (src.status !== "ok")
            throw new Error(`safari source status "${src.status}": ${src.reason ?? ""}`);
          if (FLAG.realHistory) return `${res.rows?.length ?? 0} real rows (FDA is granted)`;
          const row = (res.rows ?? []).find((r) => r.url?.includes("sweep-fixture"));
          if (!row)
            throw new Error(
              `the fixture row did not come back: ${JSON.stringify(res.rows)?.slice(0, 200)}`,
            );
          // The Cocoa->Unix conversion is the part with an off-by-978307200
          // failure mode that a shape check would sail straight past.
          const expected = Date.UTC(2026, 7, 1);
          if (Math.abs(row.visitTime - expected) > 1000) {
            throw new Error(
              `visit time ${row.visitTime} (${new Date(row.visitTime).toISOString()}) ` +
                `is not the fixture's ${new Date(expected).toISOString()} — the Cocoa epoch offset is wrong`,
            );
          }
          return `fixture row at ${new Date(row.visitTime).toISOString()}`;
        },
      );

      // --- journal: the StateStore-diff ingest, not extension frames -------
      // AppleScript-mode browsers have no event feed, so the daemon derives
      // coarse focus records by DIFFING successive polls. That ingest source
      // is switched on only for `!extensionConnected` browsers, so this is
      // the one tier that can reach it.
      // ONE window serves both remaining checks. `screenshot` is daemon-only
      // (`tabs-service.ts` screenshot() has no adapter fallback — there is no
      // AppleScript way to capture a tab), and the window tier needs a
      // cgWindowId, which the DIRECT read always reports as null: correlation
      // runs in the daemon's merge, not in the adapter.
      let shotWindow = null;
      await check("journal", `${BROWSER} AppleScript (StateStore-diff ingest)`, async () => {
        const opened = await bt(["window", "open", PAGE_A], daemonEnv);
        if (!opened.windowId) throw new Error("could not open a window to generate an event");
        owned.add(opened.windowId);
        shotWindow = opened.windowId;

        // A NEW window generates no focus record, and that is CORRECT rather
        // than a bug: `diffWindow` emits `window-focused` only on
        // `!prev.focused && next.focused` and `tab-activated` only on
        // `!old.active && tab.active` (`daemon/state.ts:107,116`). Both are
        // TRANSITIONS, and a window the store has never seen has no `prev` to
        // transition from. The first version of this check opened a window and
        // waited for a record; it waited forever — the harness was wrong about
        // the contract, not the contract about itself.
        //
        // So: let the poll learn the window, add a second tab (which becomes
        // active), then activate the FIRST one again. That is a real
        // transition, and it does not depend on which app is frontmost —
        // `active` is derived per-window from `active tab index`, whereas a
        // window-focus transition would be at the mercy of the terminal
        // stealing focus back mid-poll.
        const first = await until(
          "the poll to learn the new window",
          async () => {
            const w = await windowById(BROWSER, opened.windowId, daemonEnv).catch(() => null);
            return w?.tabs?.[0]?.tabId ?? null;
          },
          { timeoutMs: 15_000 },
        );
        await bt(["open", PAGE_B, "--window", assertOwned(opened.windowId)], daemonEnv);
        await until(
          "the poll to see the first tab go inactive",
          async () => {
            const w = await windowById(BROWSER, opened.windowId, daemonEnv).catch(() => null);
            return Boolean(
              w && w.tabs.length > 1 && w.tabs[0]?.tabId === first && !w.tabs[0].active,
            );
          },
          { timeoutMs: 15_000 },
        );
        await bt(["focus", first, "--no-raise"], daemonEnv);

        const rec = await until(
          "an AppleScript-sourced journal record",
          async () => {
            const j = await bt(["journal", "--view", "recent", "--limit", "50"], daemonEnv);
            // `source` is the whole point: an "ext" record would mean an
            // extension fed this and the diff ingest would still be unproven.
            return (
              (j.focus ?? []).find((r) => r.browser === BROWSER && r.source === "applescript") ??
              null
            );
          },
          { timeoutMs: 20_000 },
        );
        // The window is left OPEN on purpose: the screenshot check below needs
        // it, and the sweep's own `finally` closes whatever is owned.
        return `${rec.kind} record, source=${rec.source}`;
      });

      // --- screenshot, tier 2 (window) ------------------------------------
      // Needs a cgWindowId (the wm-stack join) AND Screen Recording consent.
      // Both are REPORTED, never constructed: revoking a TCC grant to prove
      // the denial path is not something a verification harness may do.
      if (!shotWindow) {
        skip("screenshot", "window tier (`screencapture -l`)", "no window to capture");
      } else {
        const cg = await until(
          "correlation to resolve a cgWindowId",
          async () => {
            const st = await bt(["list", "--browser", BROWSER], daemonEnv);
            const w = (st.browsers ?? [])
              .flatMap((b) => b.windows ?? [])
              .find((x) => x.windowId === shotWindow);
            return w?.cgWindowId ?? null;
          },
          { timeoutMs: 12_000 },
        ).catch(() => null);

        if (!cg) {
          skip(
            "screenshot",
            "window tier (`screencapture -l`)",
            "correlation never produced a cgWindowId for this window — capture has nothing to target",
          );
        } else {
          // Screen Recording consent is REPORTED, never constructed — revoking a
          // TCC grant to exercise the denial path is not something a
          // verification harness may do to a developer's machine. Absent
          // consent is therefore a skip with a named reason, exactly like the
          // tiling-WM case: the surface stays untested and the report says so,
          // rather than a red line that reads as a browser-tab defect.
          const out = join(ISO, "shot.jpg");
          let shotErr = null;
          const res = await bt(["screenshot", assertOwned(shotWindow), "--window", "--out", out], {
            ...daemonEnv,
            BROWSER_TAB_WINDOW_CAPTURE: "1",
          }).catch((err) => {
            shotErr = err;
            return null;
          });
          if (
            shotErr &&
            /screen recording|not authorized|permission|denied/i.test(shotErr.message)
          ) {
            skip(
              "screenshot",
              "window tier (`screencapture -l`)",
              "Screen Recording consent is not granted to the binary running this sweep — " +
                "`screencapture -l` cannot produce window pixels, and this sweep neither grants " +
                "nor revokes TCC",
            );
          } else {
            await check("screenshot", "window tier (`screencapture -l <cgWindowId>`)", async () => {
              if (shotErr) throw shotErr;
              if (!existsSync(out)) throw new Error(`no jpeg written: ${JSON.stringify(res)}`);
              const size = statSync(out).size;
              // A capture of a window that is not on screen comes back as a
              // few hundred bytes of nothing; a real one is tens of KB.
              if (size < 4096) {
                throw new Error(`the captured jpeg is only ${size} bytes — nothing was on screen`);
              }
              return `${size} bytes from cgWindowId ${cg}`;
            });
          }
        }
      }
    }

    daemon.kill("SIGTERM");
    await sleep(800);
    daemon.kill("SIGKILL");
  }

  // -------------------------------------------------------------------------
  // Phase 3 — Safari, opt-in, against the user's real running browser
  // -------------------------------------------------------------------------
  if (!FLAG.safari) {
    for (const s of [
      "list_tabs",
      "focus_tab",
      "open_tab",
      "close_tab",
      "move_tab",
      "tab_action",
      "open_window",
      "set_window",
      "close_window",
    ]) {
      skip(s, "safari AppleScript", "not run — pass --safari (drives your real Safari)");
    }
  } else if (!(await isRunning("Safari"))) {
    skip(
      "list_tabs",
      "safari AppleScript",
      "Safari is not running and this sweep will not launch it",
    );
  } else {
    say("Safari — real browser, record/restore, owned windows only");
    const SAF = { BROWSER_TAB_BROWSERS: "safari" };
    const preExisting = new Set((await windowsOf("safari").catch(() => [])).map((w) => w.windowId));
    note(`recorded ${preExisting.size} pre-existing Safari window(s) — none will be touched`);

    let sWin = null;
    await check("open_window", "safari AppleScript (`make new document`)", async () => {
      const res = await bt(["window", "open", PAGE_A, "--browser", "safari"], SAF);
      const after = await until("a new Safari window", async () => {
        const fresh = (await windowsOf("safari")).filter((w) => !preExisting.has(w.windowId));
        return fresh.length ? fresh : null;
      });
      if (after.length !== 1) throw new Error(`expected exactly 1 new window, saw ${after.length}`);
      sWin = after[0].windowId;
      owned.add(sWin);
      if (res.windowId && res.windowId !== sWin) {
        throw new Error(`open_window returned ${res.windowId} but the snapshot shows ${sWin}`);
      }
      return sWin;
    });

    if (sWin) {
      await check(
        "list_tabs",
        "safari AppleScript (synthetic w<id>:i<index> handles)",
        async () => {
          const { state } = await stateOf("safari");
          const w = state.windows.find((x) => x.windowId === sWin);
          const tab = w?.tabs?.[0];
          if (!tab) throw new Error("the new Safari window reports no tabs");
          // Safari has no per-tab id in its dictionary: the handle encodes the
          // window plus a 1-based POSITION, which is why it shifts under moves.
          if (!/^t:safari:w\d+:i\d+$/.test(tab.tabId)) {
            throw new Error(`"${tab.tabId}" is not a Safari synthetic handle`);
          }
          if (state.dataSource !== "applescript")
            throw new Error(`dataSource is "${state.dataSource}"`);
          return tab.tabId;
        },
      );

      await check("open_tab", "safari AppleScript (`make new tab`)", async () => {
        const before = (await windowById("safari", sWin)).tabs.length;
        await bt(["open", PAGE_B, "--browser", "safari", "--window", assertOwned(sWin)], SAF);
        const w = await until("the Safari tab count to rise", async () => {
          const cur = await windowById("safari", sWin);
          return cur.tabs.length > before ? cur : null;
        });
        return `${before} -> ${w.tabs.length} tabs`;
      });

      await check("tab_action", "safari AppleScript (navigate)", async () => {
        const w = await windowById("safari", sWin);
        const t = w.tabs[w.tabs.length - 1];
        await bt(["act", t.tabId, "navigate", "--url", PAGE_C], SAF);
        const seen = await until("the Safari URL to change", async () => {
          const cur = await windowById("safari", sWin);
          return cur.tabs.some((x) => x.url?.startsWith("https://example.org")) ? cur : null;
        });
        return seen.tabs.map((x) => x.url).find((u) => u.startsWith("https://example.org"));
      });

      await check("tab_action", "safari AppleScript (no back/forward verb)", async () => {
        const w = await windowById("safari", sWin);
        const msg = await btRefuses(["act", w.tabs[0].tabId, "back"], SAF);
        if (!/extension/i.test(msg)) throw new Error(`refusal does not name the extension: ${msg}`);
        return msg.slice(0, 80);
      });

      await check(
        "focus_tab",
        "safari AppleScript (miniaturized cleared BEFORE raise)",
        async () => {
          const w0 = await windowById("safari", sWin);
          const target = w0.tabs[0].tabId;
          await bt(["window", "set", assertOwned(sWin), "--state", "minimized"], SAF);
          await until("Safari to agree the window is miniaturized", () =>
            minimizedOf("safari", sWin),
          );
          const res = await bt(["focus", target], SAF);
          if (res.wasMinimized !== true)
            throw new Error(`wasMinimized is ${JSON.stringify(res.wasMinimized)}`);
          if (res.windowState !== "normal") {
            throw new Error(
              `windowState is ${JSON.stringify(res.windowState)} — focused but invisible`,
            );
          }
          if (await minimizedOf("safari", sWin)) {
            throw new Error(
              "focus_tab reported windowState:normal but Safari still says miniaturized — " +
                "`set miniaturized to false` did not land before `set index to 1`",
            );
          }
          return "wasMinimized=true, Safari confirms not miniaturized";
        },
      );

      await check("set_window", "safari AppleScript (bounds, clamped)", async () => {
        const want = { x: 160, y: 160, w: 880, h: 660 };
        await bt(
          [
            "window",
            "set",
            assertOwned(sWin),
            "--bounds",
            `${want.x},${want.y},${want.w},${want.h}`,
          ],
          SAF,
        );
        const w = await until("Safari bounds to change", async () => {
          const cur = await windowById("safari", sWin);
          return cur.bounds && Math.abs(cur.bounds.x - want.x) < 200 ? cur : null;
        });
        const b = w.bounds;
        if (b.w > want.w + 40 || b.h > want.h + 40) {
          throw new Error(`frame ${b.w}x${b.h} is larger than requested — not a clamp`);
        }
        return `${b.w}x${b.h} @${b.x},${b.y}`;
      });

      // move_tab: the ONE pathway in the whole repo where a move is expected
      // to lose page state, and the flag that makes the caller say so.
      await check("move_tab", "safari AppleScript (refuses without --allow-reload)", async () => {
        const w = await windowById("safari", sWin);
        const msg = await btRefuses(["move", w.tabs[w.tabs.length - 1].tabId, "--new-window"], SAF);
        if (!/reload/i.test(msg)) throw new Error(`refusal does not name the reload: ${msg}`);
        return msg.slice(0, 80);
      });

      let sWin2 = null;
      await check("move_tab", "safari AppleScript (--allow-reload lands the tab)", async () => {
        const w = await windowById("safari", sWin);
        if (w.tabs.length < 2) throw new Error("need 2 tabs to prove one moved out");
        const before = w.tabs.length;
        const res = await bt(
          ["move", w.tabs[w.tabs.length - 1].tabId, "--new-window", "--allow-reload"],
          SAF,
        );
        const fresh = await until("a second Safari window holding the tab", async () => {
          const all = await windowsOf("safari");
          const found = all.filter((x) => !preExisting.has(x.windowId) && x.windowId !== sWin);
          return found.length ? found : null;
        });
        sWin2 = fresh[0].windowId;
        owned.add(sWin2);
        const src = await windowById("safari", sWin);
        if (src.tabs.length >= before)
          throw new Error(`source window still has ${src.tabs.length} tabs`);
        if (res.windowId && res.windowId !== sWin2) {
          note(`move_tab reported ${res.windowId}; the snapshot shows ${sWin2}`);
        }
        return `${before} -> ${src.tabs.length} in source; landed in ${sWin2}`;
      });

      await check("close_tab", "safari AppleScript (`close tab`)", async () => {
        const w = await windowById("safari", sWin);
        const before = w.tabs.length;
        if (before < 2) {
          // Only one tab left: closing it closes the window, which is a
          // different assertion. Add one so this stays a tab-level check.
          await bt(["open", PAGE_B, "--browser", "safari", "--window", assertOwned(sWin)], SAF);
          await until(
            "the extra tab",
            async () => (await windowById("safari", sWin)).tabs.length > before,
          );
        }
        const cur = await windowById("safari", sWin);
        await bt(["close", cur.tabs[cur.tabs.length - 1].tabId], SAF);
        const after = await until("the Safari tab count to drop", async () => {
          const c = await windowById("safari", sWin);
          return c.tabs.length < cur.tabs.length ? c : null;
        });
        return `${cur.tabs.length} -> ${after.tabs.length} tabs`;
      });

      await check("close_window", "safari AppleScript (`close window`)", async () => {
        for (const id of [sWin2, sWin].filter(Boolean)) {
          await bt(["window", "close", assertOwned(id)], SAF);
          await until(
            `Safari window ${id} to disappear`,
            async () => !(await windowsOf("safari")).some((x) => x.windowId === id),
          );
          owned.delete(id);
        }
        sWin = null;
        sWin2 = null;
        return "closed every window this sweep created";
      });
    }
  }

  // `daemon install` is a deliberate non-run, recorded rather than skipped
  // silently: it rewrites a developer's own launchd state, and this sweep has
  // no way to undo a service the user may already depend on.
  record(
    "daemon install",
    "real launchctl bootstrap",
    "skip",
    "deliberate non-run: registering a LaunchAgent rewrites your own service state",
  );
} finally {
  // -------------------------------------------------------------------------
  // Cleanup — only what we created, then the desktop as we found it.
  // -------------------------------------------------------------------------
  say("Cleanup");
  for (const id of [...owned]) {
    const browser = id.startsWith("w:safari") ? "safari" : BROWSER;
    try {
      await bt(["window", "close", id], { BROWSER_TAB_BROWSERS: browser });
      note(`closed leftover ${id}`);
    } catch (err) {
      note(`could not close ${id}: ${err.message.split("\n")[0]}`);
    }
    owned.delete(id);
  }
  if (launchedChromium) {
    // AppleScript `quit` IS NOT ENOUGH, measured 2026-08-24: against Google
    // Chrome for Testing it returned exit 0 and the process kept running with
    // its windows open. Chrome-family browsers can defer or ignore the Apple
    // Event (a close-confirmation, a lingering renderer), and osascript has no
    // way to know. Leaving it running is not cosmetic — the NEXT run refuses
    // to start, because "already running" is the sweep's own safety rule, so a
    // silent failure here makes the harness a one-shot.
    //
    // Escalating with a signal is safe HERE and only here: this process was
    // launched by this sweep, `pgrep -x` matches the exact process name, and
    // the preflight already guaranteed no instance of it existed beforehand.
    try {
      await osa(`tell application ${JSON.stringify(TARGET.appName)} to quit`);
    } catch {
      // ignore — the escalation below is the real mechanism
    }
    let gone = false;
    for (let i = 0; i < 16 && !gone; i++) {
      gone = !(await isRunning(TARGET.processName));
      if (!gone) await sleep(500);
    }
    if (!gone) {
      for (const sig of ["-TERM", "-KILL"]) {
        try {
          execFileSync("/usr/bin/pkill", [sig, "-x", TARGET.processName], { stdio: "ignore" });
        } catch {
          // pkill exits 1 when nothing matched — that is success, not failure
        }
        await sleep(1200);
        if (!(await isRunning(TARGET.processName))) {
          gone = true;
          break;
        }
      }
    }
    note(
      gone
        ? `quit ${TARGET.appName} (this sweep launched it)`
        : `COULD NOT quit ${TARGET.appName} — quit it yourself, or the next run will refuse to start`,
    );
  }
  if (startedFrontmost) {
    try {
      await osa(`tell application ${JSON.stringify(startedFrontmost)} to activate`);
      note(`restored focus to ${startedFrontmost}`);
    } catch {
      note(`could not restore focus to ${startedFrontmost}`);
    }
  }
  rmSync(ISO, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Report — redacted, and the redaction is CHECKED rather than asserted.
//
// The file is committed and the coverage ledger cites it, so it must never
// carry anything from the user's own session. Surface, pathway, status,
// reason, git sha, browser build — that is the whole vocabulary.
//
// The one thing that legitimately looks like user data is a URL, because a
// `reason` echoes the page a check navigated to. Those can only ever be this
// file's own PAGE_A/B/C constants — so rather than CLAIM that, `redact()`
// enforces it, and does the same for home-directory paths that could ride in
// on an error message. A promise the reader has to verify by reasoning about
// the code is a promise that rots.
// ---------------------------------------------------------------------------

const ALLOWED_URLS = new Set([PAGE_A, PAGE_B, PAGE_C].map((u) => u.replace(/\/$/, "")));

function redact(text) {
  return text
    .replace(/https?:\/\/[^\s,)"']+/g, (u) =>
      ALLOWED_URLS.has(u.replace(/\/$/, "")) ? u : "<url-redacted>",
    )
    .replace(/\/Users\/[^\s,)"']+/g, "<path-redacted>");
}
function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim();
  } catch {
    return null;
  }
}
function targetVersion() {
  try {
    const exe = join(appPath(TARGET), "Contents", "MacOS", TARGET.appName);
    return execFileSync(exe, ["--version"]).toString().trim();
  } catch {
    return null;
  }
}

const failed = results.filter((r) => r.status === "fail");
const passed = results.filter((r) => r.status === "pass");
const skipped = results.filter((r) => r.status === "skip");

writeFileSync(
  REPORT,
  `${JSON.stringify(
    {
      suite: "sweep-macos",
      startedAt: new Date().toISOString(),
      gitSha: gitSha(),
      os: `${process.platform} ${execFileSync("/usr/bin/uname", ["-r"]).toString().trim()}`,
      node: process.version,
      target: TARGET ? { browser: TARGET.browser, version: targetVersion() } : null,
      safariPhase: FLAG.safari,
      realHistory: FLAG.realHistory,
      passed: passed.length,
      failed: failed.length,
      skipped: skipped.length,
      // `reason` is authored by this file or is an error message from our own
      // adapters — never page content. Truncated so a stack cannot smuggle a
      // path into a committed file.
      results: results.map((r) => ({
        ...r,
        ...(r.reason ? { reason: redact(r.reason).slice(0, 200) } : {}),
      })),
    },
    null,
    2,
  )}\n`,
);

say("Summary");
process.stdout.write(
  `  ${GREEN}${passed.length} passed${OFF}  ${failed.length ? RED : DIM}${failed.length} failed${OFF}  ${DIM}${skipped.length} skipped${OFF}\n`,
);
note(`report written to ${REPORT}`);

if (failed.length) {
  process.stderr.write(`\n${RED}sweep:macos found ${failed.length} real defect(s):${OFF}\n`);
  for (const f of failed) process.stderr.write(`  - ${f.surface} (${f.pathway}): ${f.reason}\n`);
  process.exit(1);
}
process.stdout.write(
  `\n${GREEN}sweep:macos passed${OFF} — the AppleScript pathways drove a real browser.\n`,
);
