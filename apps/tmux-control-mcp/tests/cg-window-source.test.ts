import { afterEach, describe, expect, it } from "vitest";
import { cgWindowSource, hasNativeModule } from "../src/native-bridge.js";

describe("cgWindowSource (list --processes window list)", () => {
  afterEach(() => {
    delete process.env.MCP_DISABLE_NATIVE;
  });

  it("is null with a reason when native is disabled, never an error", () => {
    process.env.MCP_DISABLE_NATIVE = "1";
    const source = cgWindowSource();
    expect(source.osWindows).toBeNull();
    expect(source.unavailable).toMatch(/MCP_DISABLE_NATIVE=1|only on macOS/);
  });

  it.skipIf(process.platform !== "darwin" || !hasNativeModule())(
    "lists only the asked pid's windows when the native module is built",
    () => {
      const source = cgWindowSource();
      expect(source.osWindows).toBeTypeOf("function");
      const windows = source.osWindows?.(process.pid) ?? [];
      expect(Array.isArray(windows)).toBe(true);
      expect(windows.every((window) => window.ownerPid === process.pid)).toBe(true);
    },
  );
});
