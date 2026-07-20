/**
 * Settings page — token/port/browser into storage.local, plus the shared
 * live status readout. Saving triggers the background worker (via
 * storage.onChanged) to (re)connect. Everything runs under an error boundary
 * so a failure surfaces instead of leaving a blank page.
 */

import { type ConnectorOptions, loadOptions, saveOptions } from "@george43g/extension-core";
import { renderStatus, requestReconnect, showFatal, startStatusPolling } from "./status-view.js";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

async function main(): Promise<void> {
  const tokenInput = el<HTMLInputElement>("token");
  const portInput = el<HTMLInputElement>("port");
  const browserSelect = el<HTMLSelectElement>("browser");
  const saveButton = el<HTMLButtonElement>("save");
  const testButton = el<HTMLButtonElement>("test");
  const note = el<HTMLSpanElement>("note");

  // Populate the form from stored options — before wiring, so a load failure
  // still leaves usable inputs rather than a dead page.
  try {
    const options = await loadOptions();
    tokenInput.value = options.token;
    portInput.value = String(options.port);
    browserSelect.value = options.browser;
  } catch (err) {
    showFatal(`couldn't read saved settings: ${(err as Error).message}`);
  }

  saveButton.addEventListener("click", () => {
    void (async () => {
      const options: ConnectorOptions = {
        token: tokenInput.value.trim(),
        port: Number.parseInt(portInput.value, 10) || 8790,
        browser: browserSelect.value as ConnectorOptions["browser"],
      };
      await saveOptions(options);
      note.textContent = "saved ✓";
      setTimeout(() => {
        note.textContent = "";
      }, 2000);
    })();
  });

  testButton.addEventListener("click", () => {
    void (async () => {
      note.textContent = "reconnecting…";
      renderStatus(await requestReconnect());
      setTimeout(() => {
        note.textContent = "";
      }, 1500);
    })();
  });

  startStatusPolling(1000);
}

main().catch((err) => showFatal((err as Error).message));
