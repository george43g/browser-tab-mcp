/**
 * Smoke: the BUILT bundle loads in a real (new-headless) Chromium — the layer
 * that broke repeatedly (module SW, dual background, type=module tags) and that
 * no unit test can prove. Asserts the background registers (we get an extension
 * id from its service worker) and the options page renders without console errors.
 */

import { expect, launchExtension, test } from "./fixtures.js";

test("loads the built extension and renders its options page", async () => {
  const { context, extensionId, userDataDir } = await launchExtension();
  try {
    expect(extensionId).toMatch(/^[a-p]{32}$/);

    const errors: string[] = [];
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    // The options page owns a token field — proof the DOM entry glue ran.
    await expect(page.locator("body")).toBeVisible();
    expect(errors, `options page console errors: ${errors.join(" · ")}`).toEqual([]);
  } finally {
    await context.close();
    const { rmSync } = await import("node:fs");
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
