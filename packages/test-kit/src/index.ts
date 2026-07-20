/**
 * @george43g/test-kit — shared fixtures + fakes for the browser-tab workspace.
 *
 * Main barrel: `make*` factories + the `installFakeChrome` / `withDaemonEnv`
 * global-lifecycle fakes. ZERO runtime dependencies — the `ws`-backed
 * `installNodeWebSocket` lives on the `./node` subpath. See README for rules.
 */

export {
  type ChromeTabLike,
  type ChromeWindowLike,
  makeChromeTab,
  makeChromeWindow,
} from "./factories/chrome-api.js";
export {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "./factories/contract.js";
export { makeExtSnapshot, makeExtTab, makeExtWindow } from "./factories/ext-wire.js";
export { type FakeChrome, type FakeChromeConfig, installFakeChrome } from "./fakes/chrome.js";
export {
  type DaemonEnvOptions,
  makeTmpDir,
  randomWsPort,
  withDaemonEnv,
} from "./fakes/daemon-env.js";
