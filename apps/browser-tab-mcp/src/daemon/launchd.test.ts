/**
 * The plist generator had no test at all, which is how a key silently stops
 * being emitted: `buildPlist` returns a string, nothing parses it, and a
 * dropped `<key>` looks identical to a working install until the daemon
 * misbehaves months later on someone's machine.
 */
import { describe, expect, it } from "vitest";
import { buildPlist } from "./launchd.js";

/** Minimal reader for the flat <key>/<value> dict this generator emits. */
function readKey(plist: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<(\\w+)(?:/>|>([^<]*)</\\1>)`).exec(plist);
  if (!m) return null;
  return m[2] ?? m[1] ?? "";
}

describe("buildPlist", () => {
  const plist = buildPlist("/usr/local/bin/node", "/opt/browser-tab/cli.js");

  it("respawns, but not faster than ThrottleInterval", () => {
    // KeepAlive without a throttle is launchd's 10s default — ~360 cold starts
    // an hour for a daemon in a restart loop, each one CPU-intensive module
    // loading, on the very host whose saturation caused the loop (B15).
    expect(readKey(plist, "KeepAlive")).toBe("true");
    expect(readKey(plist, "ThrottleInterval")).toBe("30");
  });

  it("runs at load, in the background, under the given node and cli paths", () => {
    expect(readKey(plist, "RunAtLoad")).toBe("true");
    expect(readKey(plist, "ProcessType")).toBe("Background");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>/opt/browser-tab/cli.js</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>run</string>");
  });

  it("escapes XML metacharacters in paths rather than emitting broken plist", () => {
    const escaped = buildPlist("/usr/bin/node", "/tmp/a&b/cli.js");
    expect(escaped).toContain("/tmp/a&amp;b/cli.js");
    expect(escaped).not.toContain("/tmp/a&b/cli.js");
  });
});
