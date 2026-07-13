import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolTimeoutError, withTimeout } from "./with-timeout.js";

const FORCE_KEY = "MCP_TOOL_TIMEOUT_FORCE_MS";

describe("withTimeout", () => {
  beforeEach(() => {
    delete process.env[FORCE_KEY];
  });
  afterEach(() => {
    delete process.env[FORCE_KEY];
  });

  it("returns value when fn resolves under the deadline", async () => {
    const result = await withTimeout("fast", async () => 42, 1000);
    expect(result).toBe(42);
  });

  it("propagates thrown errors verbatim", async () => {
    await expect(
      withTimeout(
        "throwing",
        async () => {
          throw new Error("boom");
        },
        1000,
      ),
    ).rejects.toThrow("boom");
  });

  it("throws ToolTimeoutError when fn exceeds the deadline", async () => {
    const promise = withTimeout(
      "slow",
      () => new Promise((resolve) => setTimeout(resolve, 200).unref()),
      10,
    );
    await expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    await expect(promise).rejects.toMatchObject({ toolName: "slow", timeoutMs: 10 });
  });

  it("disables the wrapper when timeoutMs <= 0", async () => {
    const result = await withTimeout("unbounded", async () => "ok", 0);
    expect(result).toBe("ok");
  });

  it("MCP_TOOL_TIMEOUT_FORCE_MS overrides per-tool timeout", async () => {
    process.env[FORCE_KEY] = "5";
    const promise = withTimeout(
      "forced",
      () => new Promise((resolve) => setTimeout(resolve, 100).unref()),
      60_000, // would normally not time out
    );
    await expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    await expect(promise).rejects.toMatchObject({ timeoutMs: 5 });
  });
});
