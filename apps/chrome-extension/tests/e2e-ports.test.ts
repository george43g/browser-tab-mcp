/**
 * The e2e port registry agrees with what is actually on disk.
 *
 * WHY THIS IS A VITEST TEST AND NOT AN E2E ONE. It has to fail in `pnpm test`,
 * which every developer and every CI leg runs in seconds — not behind a
 * browser install and a Playwright run. A spec file added without a band is a
 * five-second failure here; discovered at e2e time it is a confusing timeout
 * waiting for `dataSource: "extension"`, because a lost WS bind is swallowed
 * as `ws_disabled` rather than raised.
 *
 * `e2e/ports.ts` deliberately imports nothing from `@playwright/test` so this
 * file can read it. `vitest.config.ts` excludes `e2e/**` as *test files*;
 * importing a plain module from there is unaffected.
 */

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bandCeiling,
  bandFor,
  E2E_PORT_BASE,
  E2E_PORT_SPAN,
  E2E_SPEC_SLOTS,
} from "../e2e/ports.js";

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "e2e");

const specsOnDisk = (): string[] =>
  readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".e2e.test.ts"))
    .sort();

describe("e2e port bands", () => {
  it("finds spec files at all (canary on the directory read)", () => {
    // If the glob or the path were wrong, every assertion below would compare
    // two empty sets and pass — the failure mode of a registry test.
    expect(specsOnDisk().length).toBeGreaterThan(0);
  });

  it("registers exactly the spec files that exist — no gaps, no orphans", () => {
    const disk = specsOnDisk();
    const registered = [...E2E_SPEC_SLOTS].sort();

    const missing = disk.filter((f) => !E2E_SPEC_SLOTS.includes(f));
    const orphaned = registered.filter((f) => !disk.includes(f));

    expect(
      missing,
      `spec file(s) with no port band: ${missing.join(", ")}. Append them to ` +
        `E2E_SPEC_SLOTS in e2e/ports.ts — without a band, startDaemon() throws.`,
    ).toEqual([]);
    expect(
      orphaned,
      `E2E_SPEC_SLOTS names file(s) that no longer exist: ${orphaned.join(", ")}. ` +
        `A stale slot silently shifts every band after it.`,
    ).toEqual([]);
  });

  it("gives every spec a disjoint band inside the range e2e owns", () => {
    const seen: Array<{ name: string; base: number; end: number }> = [];
    for (const name of E2E_SPEC_SLOTS) {
      const { base, span } = bandFor(name);
      const end = base + span - 1;

      expect(base, `${name} starts below the e2e range`).toBeGreaterThanOrEqual(E2E_PORT_BASE);
      expect(end, `${name} runs past the e2e range`).toBeLessThanOrEqual(bandCeiling());
      expect(span).toBe(E2E_PORT_SPAN);

      for (const prior of seen) {
        const overlaps = base <= prior.end && end >= prior.base;
        expect(
          overlaps,
          `${name} (${base}-${end}) overlaps ${prior.name} (${prior.base}-${prior.end})`,
        ).toBe(false);
      }
      seen.push({ name, base, end });
    }
  });

  it("stays clear of the vitest integration bands", () => {
    // Those files claim 18790-19289 and 20100-23899 in pieces; e2e owning
    // everything from 24500 up is what keeps the two suites from colliding
    // when they run concurrently under turbo.
    expect(E2E_PORT_BASE).toBeGreaterThan(23_899);
  });

  it("refuses an unregistered spec by name rather than defaulting", () => {
    // The whole point: no silent fall-back to a shared port.
    expect(() => bandFor("not-registered.e2e.test.ts")).toThrow(/no port band/);
    expect(() => bandFor("not-registered.e2e.test.ts")).toThrow(/E2E_SPEC_SLOTS/);
  });
});
