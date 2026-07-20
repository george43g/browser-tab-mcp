/**
 * Toolbar popup — a live status readout of the daemon connection. Reads
 * everything from the background worker; no direct socket access.
 */

import { api } from "@george43g/extension-core";
import { renderStatus, requestReconnect, showFatal, startStatusPolling } from "./status-view.js";

function wire(): void {
  document.getElementById("reconnect")?.addEventListener("click", () => {
    void (async () => {
      renderStatus(await requestReconnect());
    })();
  });
  document.getElementById("settings")?.addEventListener("click", () => {
    // openOptionsPage isn't in every engine; fall back to a tab.
    if (typeof api.runtime.openOptionsPage === "function") api.runtime.openOptionsPage();
    else api.tabs.create({ url: api.runtime.getURL("options.html") });
    window.close();
  });
}

try {
  wire();
  startStatusPolling(1000);
} catch (err) {
  showFatal((err as Error).message);
}
