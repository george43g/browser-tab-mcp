import shared from "@george43g/vitest-config/vitest.shared";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    },
  }),
);
