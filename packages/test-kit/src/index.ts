/**
 * @george43g/test-kit — shared fixtures + fakes for the browser-tab workspace.
 *
 * Main barrel: `make*` factories + the `installFakeChrome` / `withDaemonEnv`
 * global-lifecycle fakes. ZERO runtime dependencies — the `ws`-backed
 * `installNodeWebSocket` lives on the `./node` subpath. See README for rules.
 */

export {
  type ChromeMutedInfoLike,
  type ChromeTabGroupLike,
  type ChromeTabLike,
  type ChromeWindowLike,
  makeChromeTab,
  makeChromeTabGroup,
  makeChromeWindow,
} from "./factories/chrome-api.js";
export {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
  makeTabGroup,
} from "./factories/contract.js";
export {
  makeExtSnapshot,
  makeExtTab,
  makeExtTabGroup,
  makeExtWindow,
} from "./factories/ext-wire.js";
export { type FakeChrome, type FakeChromeConfig, installFakeChrome } from "./fakes/chrome.js";
export {
  type DaemonEnvOptions,
  makeTmpDir,
  randomWsPort,
  withDaemonEnv,
} from "./fakes/daemon-env.js";
export { ARTICLE_HTML, DIRTY_FORM_HTML, MEDIA_HTML, SPA_HTML } from "./fixtures/html.js";
