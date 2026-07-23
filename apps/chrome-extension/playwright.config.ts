import { defineConfig } from "@playwright/test";

/**
 * E2E of the BUILT extension bundle against a throwaway, HOME-isolated daemon.
 * A real Chromium loads `dist/` (new-headless — the full chromium build, which
 * supports MV3 extensions, not the headless shell), connects to the daemon over
 * loopback, and a cross-window move is asserted to preserve page state.
 *
 * Serial (one browser + one daemon at a time), retried once in CI where the
 * real-browser timing is flakier. Run with `pnpm --filter
 * @george43g/chrome-extension test:e2e` after `pnpm build`.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.test.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    trace: "on-first-retry",
    video: "on-first-retry",
  },
});
