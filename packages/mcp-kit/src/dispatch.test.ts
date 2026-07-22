import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildDispatcher } from "./dispatch.js";
import { makeRegistry, type ToolDefinition } from "./tool-registry.js";

const FORCE_KEY = "MCP_TOOL_TIMEOUT_FORCE_MS";

beforeEach(() => {
  delete process.env[FORCE_KEY];
});

afterEach(() => {
  delete process.env[FORCE_KEY];
});

const echo: ToolDefinition = {
  name: "echo",
  description: "Echo input",
  input: z.object({ input: z.string() }),
  output: z.object({ echo: z.string() }),
  annotations: { readOnlyHint: true },
  handler: async ({ input }) => ({ echo: input }),
};

const slow: ToolDefinition = {
  name: "slow",
  description: "Sleeps",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  annotations: { readOnlyHint: true },
  timeoutMs: 50,
  handler: () =>
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: true }), 200).unref();
    }),
};

const throws: ToolDefinition = {
  name: "throws",
  description: "Always throws",
  input: z.object({}),
  output: z.object({}),
  annotations: {},
  handler: async () => {
    throw new Error("kaboom");
  },
};

const withImage: ToolDefinition = {
  name: "with_image",
  description: "Emits an image block via toContent",
  input: z.object({}),
  output: z.object({ path: z.string() }),
  annotations: { readOnlyHint: true },
  handler: async () => ({ path: "/tmp/x.jpg" }),
  toContent: () => [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }],
};

const badToContent: ToolDefinition = {
  name: "bad_to_content",
  description: "toContent throws — must degrade to text",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  annotations: { readOnlyHint: true },
  handler: async () => ({ ok: true }),
  toContent: () => {
    throw new Error("boom");
  },
};

const registry = makeRegistry([echo, slow, throws, withImage, badToContent]);

describe("buildDispatcher", () => {
  it("returns structuredContent on success", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("echo", { input: "hi" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ echo: "hi" });
    expect(r._meta?.engine).toBe("ts");
    expect(typeof r._meta?.duration_ms).toBe("number");
  });

  it("rejects unknown tool", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("ghost", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown tool/);
  });

  it("rejects malformed input via Zod", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("echo", { input: 42 });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Invalid arguments/);
  });

  it("returns timeout error when handler exceeds budget", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("slow", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Timed out/);
  });

  it("wraps thrown errors", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("throws", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/kaboom/);
  });

  it("emits toContent blocks before the JSON text block", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("with_image", {});
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(2);
    expect(r.content[0]).toEqual({ type: "image", data: "AAAA", mimeType: "image/jpeg" });
    expect(r.content[1]?.type).toBe("text"); // structured JSON summary still present
    expect(r.structuredContent).toEqual({ path: "/tmp/x.jpg" });
  });

  it("degrades to text when toContent throws", async () => {
    const dispatch = buildDispatcher({ registry });
    const r = await dispatch("bad_to_content", {});
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.type).toBe("text");
  });

  it("uses caller-supplied engine label in _meta", async () => {
    const dispatch = buildDispatcher({ registry, engineLabel: () => "rust" });
    const r = await dispatch("echo", { input: "x" });
    expect(r._meta?.engine).toBe("rust");
  });

  it("invokes onCall and onError counters", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const dispatch = buildDispatcher({
      registry,
      onCall: (n) => calls.push(n),
      onError: (n) => errors.push(n),
    });
    await dispatch("echo", { input: "x" });
    await dispatch("ghost", {});
    expect(calls).toEqual(["echo", "ghost"]);
    expect(errors).toEqual(["ghost"]);
  });
});
