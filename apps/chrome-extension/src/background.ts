/**
 * MV3 service worker entry.
 *
 * Lifetime strategy: the open WebSocket's message traffic (daemon pings
 * every 20s, snapshots on tab events) resets Chrome's 30s idle timer
 * (Chrome 116+). A chrome.alarms watchdog (every 30s) restarts the socket
 * after Chrome kills and later respawns the worker, and picks up options
 * changes.
 */

import { api, DaemonSocket, loadOptions } from "@george43g/extension-core";

const EXT_VERSION = api.runtime.getManifest().version;
const ALARM = "browser-tab-keepalive";

let socket: DaemonSocket | null = null;
let configKey = "";

async function ensureSocket(): Promise<void> {
  const options = await loadOptions();
  if (!options.token) return; // unconfigured — options page not filled in yet
  const key = `${options.browser}:${options.port}:${options.token}`;
  if (socket && key === configKey) {
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

api.alarms.create(ALARM, { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void ensureSocket();
});
api.runtime.onStartup.addListener(() => void ensureSocket());
api.runtime.onInstalled.addListener(() => void ensureSocket());
api.storage.onChanged.addListener(() => void ensureSocket());

void ensureSocket();
