/**
 * One WS port band per e2e spec file.
 *
 * THE DEFECT THIS PREVENTS. `startDaemon()` used to draw its port from the pid
 * (`24_500 + pid % 2000`), and `playwright.config.ts` pins `workers: 1` — so
 * every spec file in a run drew the SAME port. That has never bitten only
 * because exactly one spec file starts a daemon today. It bites the moment a
 * second one does, and it bites silently: the daemon SWALLOWS `EADDRINUSE`
 * (`daemon/index.ts`, `ws_disabled`), sets `ext = null`, and still reports
 * `reachable: true`. So `startDaemon()` returns happily, the extension never
 * connects, and the test either times out waiting for `dataSource:
 * "extension"` with a misleading message, or — worse — passes vacuously if it
 * never checked. This is the same swallowed-bind flake the vitest side already
 * had to fix once; the convention it settled on lives in
 * `packages/test-kit/src/fakes/daemon-env.ts`.
 *
 * NO PLAYWRIGHT IMPORT IN THIS FILE, deliberately. `tests/e2e-ports.test.ts`
 * is a vitest test that imports this module to check the registry against
 * what is actually on disk — it runs in the cheap `pnpm test`, long before
 * anyone waits on a browser install. `vitest.config.ts` excludes `e2e/**` as
 * *test files*; importing a plain module from there is unaffected.
 */

/** The band e2e already owns; 21500-23899 belongs to the vitest integration files. */
export const E2E_PORT_BASE = 24_500;
/** Ports per spec file. 20 slots x 100 = 24500..26499, exactly the claimed band. */
export const E2E_PORT_SPAN = 100;

/**
 * Every spec file, in slot order. Index = band offset.
 *
 * Files that never start a daemon still occupy a slot. Strict set equality
 * against the directory (asserted in `tests/e2e-ports.test.ts`) beats a
 * nullable registry: a spec that is missing here should be a loud failure at
 * `pnpm test`, not a silent fall-back to a shared port at e2e time.
 *
 * Adding a spec file means adding its basename here. Order is append-only —
 * reordering silently reassigns every band below the insertion point, which is
 * harmless in a serial run and confusing in any other.
 */
export const E2E_SPEC_SLOTS: readonly string[] = [
  "load.e2e.test.ts",
  "roundtrip.e2e.test.ts",
  "tabs-lifecycle.e2e.test.ts",
];

export interface PortBand {
  base: number;
  span: number;
}

/**
 * The band for a spec file, by basename.
 *
 * Throws — by name, with the fix — rather than returning a default. An
 * unregistered spec falling back to a shared band is precisely the failure
 * this module exists to remove, and a silent default would reintroduce it.
 */
export function bandFor(specBasename: string): PortBand {
  const slot = E2E_SPEC_SLOTS.indexOf(specBasename);
  if (slot < 0) {
    throw new Error(
      `e2e spec "${specBasename}" has no port band. Add it to E2E_SPEC_SLOTS in ` +
        `e2e/ports.ts (append, do not reorder). Without a band it would share a WS ` +
        `port with another spec, and a lost bind is swallowed as ws_disabled rather ` +
        `than raised.`,
    );
  }
  return { base: E2E_PORT_BASE + slot * E2E_PORT_SPAN, span: E2E_PORT_SPAN };
}

/** Draw a port from a spec's band — random within the band, like `randomWsPort`. */
export function portForSpec(specBasename: string): number {
  const { base, span } = bandFor(specBasename);
  return base + Math.floor(Math.random() * span);
}

/** Highest port any slot can occupy — used by the registry test's range check. */
export function bandCeiling(): number {
  return E2E_PORT_BASE + E2E_SPEC_SLOTS.length * E2E_PORT_SPAN - 1;
}
