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

  it("emits no $schema dialect label on any tool schema (eqstack #184 guard)", () => {
    const tools = makeRegistry([prod, dev]).toMcpTools(true) as unknown as Array<{
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.inputSchema).not.toHaveProperty("$schema");
      expect(t.outputSchema).toBeDefined();
      expect(t.outputSchema).not.toHaveProperty("$schema");
    }
  });

  it("emits tuples as 2020-12 prefixItems, never draft-07 array-form items", () => {
    const tuple: ToolDefinition = {
      ...prod,
      name: "tuple_tool",
      input: z.object({ pair: z.tuple([z.string(), z.number()]) }),
    };
    const [t] = makeRegistry([tuple]).toMcpTools() as unknown as Array<{
      inputSchema: { properties: { pair: Record<string, unknown> } };
    }>;
    const pair = t.inputSchema.properties.pair;
    expect(pair.prefixItems).toEqual([{ type: "string" }, { type: "number" }]);
    expect(Array.isArray(pair.items)).toBe(false);
    const draft07Only = (n: unknown): string[] =>
      Array.isArray(n)
        ? n.flatMap(draft07Only)
        : n && typeof n === "object"
          ? Object.entries(n).flatMap(([k, v]) => [
              ...((k === "items" && Array.isArray(v)) ||
              k === "definitions" ||
              k === "dependencies" ||
              k === "additionalItems"
                ? [k]
                : []),
              ...draft07Only(v),
            ])
          : [];
    expect(draft07Only(t)).toEqual([]);
  });

  it("passes annotations through to tools/list verbatim, title included", () => {
    const annotated: ToolDefinition = {
      ...prod,
      name: "annotated_tool",
      annotations: {
        title: "Annotated tool",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
    const r = makeRegistry([annotated]);
    const [tool] = r.toMcpTools();
    expect(tool?.annotations).toEqual({
      title: "Annotated tool",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
});
