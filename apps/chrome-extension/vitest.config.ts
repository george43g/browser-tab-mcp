import extension from "@george43g/vitest-config/vitest.extension";
import { configDefaults, mergeConfig } from "vitest/config";

// Extension tier: environment "node" by default; DOM-touching tests opt in
// per-file with `// @vitest-environment happy-dom`.
//
// The Playwright e2e suite (`e2e/*.e2e.test.ts`) drives a real Chromium via
// its own runner — exclude it from the vitest unit run (vitest's default
// include glob would otherwise sweep it in).
export default mergeConfig(extension, {
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
