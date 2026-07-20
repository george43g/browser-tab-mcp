/**
 * MV3 background worker (service worker in Chrome; background page in
 * Safari). Owns the daemon socket and reports live status to the popup /
 * options pages via runtime messaging.
 *
 * Lifetime: the open WebSocket's message traffic (daemon pings every 20s,
 * snapshots on tab events) resets Chrome's 30s idle timer (Chrome 116+). A
 * chrome.alarms watchdog restarts the socket after a respawn and picks up
 * options changes. Safari differences (missing `alarms`, background-page
 * lifetime) are guarded so one unsupported call can't silently kill the
 * worker — the failure is logged and surfaced instead.
 */

import {
  api,
  type BrowserName,
  type ConnectorStatus,
  DaemonSocket,
  derivePhase,
  loadOptions,
  log,
  logError,
  logWarn,
  type PageMessage,
  type SocketState,
} from "@george43g/extension-core";

const EXT_VERSION = safeManifestVersion();
const ALARM = "browser-tab-keepalive";

let socket: DaemonSocket | null = null;
let configKey = "";
/** Last known config, for status when the socket isn't up yet. */
let lastConfig: { browser: BrowserName; port: number; hasToken: boolean } = {
  browser: "chrome",
  port: 8790,
  hasToken: false,
};

function safeManifestVersion(): string {
  try {
    return api.runtime.getManifest().version;
  } catch {
    return "0.0.0";
  }
}

const EMPTY_SOCKET_STATE: SocketState = {
  connected: false,
  connectedAt: null,
  lastSnapshot: null,
  lastError: null,
  reconnectAttempts: 0,
};

export function currentStatus(): ConnectorStatus {
  const socketState = socket?.getState() ?? EMPTY_SOCKET_STATE;
  return {
    phase: derivePhase(socketState, lastConfig.hasToken),
    browser: lastConfig.browser,
    port: lastConfig.port,
    extVersion: EXT_VERSION,
    hasToken: lastConfig.hasToken,
    connectedAt: socketState.connectedAt,
    lastSnapshot: socketState.lastSnapshot,
    lastError: socketState.lastError,
    reconnectAttempts: socketState.reconnectAttempts,
  };
}

export async function ensureSocket(force = false): Promise<void> {
  const options = await loadOptions();
  lastConfig = { browser: options.browser, port: options.port, hasToken: options.token.length > 0 };
  if (!options.token) {
    if (socket) {
      socket.stop();
      socket = null;
      configKey = "";
    }
    return; // unconfigured — options page not filled in yet
  }
  const key = `${options.browser}:${options.port}:${options.token}`;
  if (socket && key === configKey && !force) {
    socket.ensureConnected();
    return;
  }
  socket?.stop();
  configKey = key;
  socket = new DaemonSocket({
    port: options.port,
    token: options.token,
    browser: options.browser,
    extVersion: EXT_VERSION,
  });
  socket.start();
}

/** Register the keepalive alarm, tolerating browsers without `alarms`. */
function installKeepalive(): void {
  try {
    if (!api.alarms) {
      logWarn("chrome.alarms unavailable — relying on socket reconnect only");
      return;
    }
    api.alarms.create(ALARM, { periodInMinutes: 0.5 });
    api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM) void ensureSocket();
    });
  } catch (err) {
    logWarn("keepalive alarm setup failed:", (err as Error).message);
  }
}

/**
 * Chrome resolves runtime.sendMessage via the `sendResponse` callback (and
 * needs `return true` to keep the channel open for an async reply). Safari
 * and Firefox use the promise-based `browser.*` API: the sender's promise
 * only resolves if the listener RETURNS a promise — a `sendResponse` call is
 * ignored. We detect the namespace and reply in the matching style, else the
 * popup/options pages hang and show "background worker isn't responding".
 */
const USES_PROMISE_MESSAGING = typeof (globalThis as { browser?: unknown }).browser !== "undefined";

/** Popup / options pages ask for status and can force a reconnect. */
export function installMessaging(): void {
  api.runtime.onMessage.addListener(
    (message: PageMessage, _sender, sendResponse: (r: ConnectorStatus) => void) => {
      if (message?.type !== "getStatus" && message?.type !== "reconnect") return undefined;
      const reply = (async () => {
        if (message.type === "reconnect") await ensureSocket(true);
        return currentStatus();
      })();
      if (USES_PROMISE_MESSAGING) return reply; // Safari / Firefox
      void reply.then(sendResponse); // Chrome
      return true; // keep the channel open for the async reply
    },
  );
}

function main(): void {
  try {
    installKeepalive();
    installMessaging();
    api.runtime.onStartup?.addListener(() => void ensureSocket());
    api.runtime.onInstalled?.addListener(() => void ensureSocket());
    api.storage.onChanged.addListener(() => void ensureSocket());
    log(`worker up · v${EXT_VERSION}`);
    void ensureSocket();
  } catch (err) {
    logError("background worker failed to initialize:", (err as Error).message);
  }
}

main();
