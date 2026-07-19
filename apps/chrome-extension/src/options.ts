/**
 * Options page logic — token/port/browser-name into storage.local.
 */

import { type ConnectorOptions, loadOptions, saveOptions } from "@george43g/extension-core";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const tokenInput = el<HTMLInputElement>("token");
const portInput = el<HTMLInputElement>("port");
const browserSelect = el<HTMLSelectElement>("browser");
const saveButton = el<HTMLButtonElement>("save");
const status = el<HTMLSpanElement>("status");

async function init(): Promise<void> {
  const options = await loadOptions();
  tokenInput.value = options.token;
  portInput.value = String(options.port);
  browserSelect.value = options.browser;
}

saveButton.addEventListener("click", () => {
  void (async () => {
    const options: ConnectorOptions = {
      token: tokenInput.value.trim(),
      port: Number.parseInt(portInput.value, 10) || 8790,
      browser: browserSelect.value as ConnectorOptions["browser"],
    };
    await saveOptions(options);
    status.textContent = "saved ✓";
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  })();
});

void init();
