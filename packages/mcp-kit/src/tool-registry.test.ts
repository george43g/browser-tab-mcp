import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeRegistry, type ToolDefinition } from "./tool-registry.js";

const prod: ToolDefinition = {
  name: "prod_tool",
  description: "Production tool",
  input: z.object({ x: z.string() }),
  output: z.object({ y: z.string() }),
  annotations: { readOnlyHint: true },
  handler: async ({ x }) => ({ y: x.toUpperCase() }),
};

const dev: ToolDefinition = {
  name: "dev_tool",
  description: "Dev-only",
  input: z.object({}),
  output: z.object({}),
  annotations: {},
  devOnly: true,
  handler: async () => ({}),
};

describe("makeRegistry", () => {
  it("exposes get() lookup", () => {
    const r = makeRegistry([prod, dev]);
    expect(r.get("prod_tool")).toBe(prod);
    expect(r.get("nope")).toBeUndefined();
  });

  it("toMcpTools() excludes devOnly by default", () => {
    const r = makeRegistry([prod, dev]);
    const tools = r.toMcpTools();
    expect(tools.map((t) => t.name)).toEqual(["prod_tool"]);
  });

  it("toMcpTools(true) includes devOnly", () => {
    const r = makeRegistry([prod, dev]);
    const tools = r.toMcpTools(true);
    expect(tools.map((t) => t.name)).toEqual(["prod_tool", "dev_tool"]);
  });

  it("emits inputSchema and outputSchema", () => {
    const r = makeRegistry([prod]);
    const [tool] = r.toMcpTools();
    expect(tool?.inputSchema).toBeDefined();
    // @ts-expect-error — outputSchema is on the SDK Tool type
    expect(tool?.outputSchema).toBeDefined();
  });
});
