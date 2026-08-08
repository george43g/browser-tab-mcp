/**
 * Pins the curated env↔flag contract. AGENTS.md claimed this existed for every
 * env var and nothing was actually bound; these tests make the real, smaller
 * contract fail loudly if a name drifts or precedence inverts.
 */

import { applyEnvFromFlags, bindEnvFlags } from "@george43g/cli-kit";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_FLAG_OPTS, ENV_FLAGS } from "./env-flags.js";

const TOUCHED = ENV_FLAGS.map((b) => b.envVar);
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});
function stash(key: string, value?: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function build(): Command {
  const p = new Command();
  p.exitOverride();
  bindEnvFlags(p, ENV_FLAGS, ENV_FLAG_OPTS);
  return p;
}

describe("curated env↔flag bindings", () => {
  it("derives exactly the documented flag names", () => {
    const flags = build()
      .options.map((o) => o.long)
      .sort();
    expect(flags).toEqual(
      [
        "--log-dir",
        "--disable-native",
        "--socket-path",
        "--ws-port",
        "--state-dir",
        "--cache-dir",
        "--browsers",
        "--poll-ms",
        "--fake-adapter",
        "--dev",
      ].sort(),
    );
  });

  it("covers the knobs the e2e harness drives an isolated daemon with", () => {
    for (const v of [
      "BROWSER_TAB_SOCKET_PATH",
      "BROWSER_TAB_WS_PORT",
      "BROWSER_TAB_STATE_DIR",
      "BROWSER_TAB_CACHE_DIR",
    ]) {
      expect(TOUCHED).toContain(v);
    }
  });

  it("a flag overrides an existing env var", () => {
    stash("BROWSER_TAB_WS_PORT", "9999");
    const p = build();
    p.parse(["node", "x", "--ws-port", "8123"]);
    applyEnvFromFlags(p, ENV_FLAGS, ENV_FLAG_OPTS);
    expect(process.env.BROWSER_TAB_WS_PORT).toBe("8123");
  });

  it("leaves env untouched when the flag is absent", () => {
    stash("BROWSER_TAB_WS_PORT", "9999");
    const p = build();
    p.parse(["node", "x"]);
    applyEnvFromFlags(p, ENV_FLAGS, ENV_FLAG_OPTS);
    expect(process.env.BROWSER_TAB_WS_PORT).toBe("9999");
  });

  it("boolean flags set 1 when present", () => {
    stash("BROWSER_TAB_FAKE_ADAPTER", undefined);
    const p = build();
    p.parse(["node", "x", "--fake-adapter"]);
    applyEnvFromFlags(p, ENV_FLAGS, ENV_FLAG_OPTS);
    expect(process.env.BROWSER_TAB_FAKE_ADAPTER).toBe("1");
  });

  it("every binding has a help description", () => {
    for (const b of ENV_FLAGS) expect(b.description.length).toBeGreaterThan(4);
  });
});
