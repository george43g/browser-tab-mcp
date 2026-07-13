import { describe, expect, it } from "vitest";
import { buildResourcesHandler } from "./resources.js";

describe("buildResourcesHandler", () => {
  it("onList returns the provider's resources (empty by default)", async () => {
    const empty = buildResourcesHandler({
      provider: { read: async () => ({ uri: "x", mimeType: "text/plain", text: "" }) },
    });
    expect(await empty.onList()).toEqual({ resources: [] });

    const populated = buildResourcesHandler({
      provider: {
        list: () => [{ uri: "health://", name: "Health", mimeType: "application/json" }],
        read: async () => ({ uri: "health://", mimeType: "application/json", text: "{}" }),
      },
    });
    const result = await populated.onList();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toMatchObject({ uri: "health://", name: "Health" });
  });

  it("onListTemplates returns provider's templates (empty by default)", async () => {
    const handler = buildResourcesHandler({
      provider: {
        listTemplates: () => [
          {
            uriTemplate: "logs://recent/{n}",
            name: "Recent log lines",
            description: "Last N NDJSON entries",
            mimeType: "application/x-ndjson",
          },
        ],
        read: async () => ({ uri: "x", mimeType: "text/plain", text: "" }),
      },
    });
    const result = await handler.onListTemplates();
    expect(result.resourceTemplates).toHaveLength(1);
    expect(result.resourceTemplates[0]?.uriTemplate).toBe("logs://recent/{n}");
  });

  it("onRead returns the provider's content wrapped in `contents: []`", async () => {
    const handler = buildResourcesHandler({
      provider: {
        read: async (uri) => ({ uri, mimeType: "application/json", text: JSON.stringify({ uri }) }),
      },
    });
    const result = await handler.onRead({ params: { uri: "health://" } });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.uri).toBe("health://");
    expect(result.contents[0]?.text).toBe('{"uri":"health://"}');
  });

  it("onRead wraps unknown-URI errors with a structured hint", async () => {
    const handler = buildResourcesHandler({
      provider: {
        read: async (uri) => {
          throw new Error(`no handler for ${uri}`);
        },
      },
    });
    await expect(handler.onRead({ params: { uri: "bogus://" } })).rejects.toThrowError(
      /resources\/read/,
    );
    await expect(handler.onRead({ params: { uri: "bogus://" } })).rejects.toThrowError(
      /bogus:\/\//,
    );
  });

  it("supports async provider methods", async () => {
    const handler = buildResourcesHandler({
      provider: {
        list: async () => [{ uri: "async://", name: "Async" }],
        listTemplates: async () => [],
        read: async (uri) => ({ uri, mimeType: "text/plain", text: "ok" }),
      },
    });
    expect((await handler.onList()).resources).toHaveLength(1);
    expect((await handler.onListTemplates()).resourceTemplates).toHaveLength(0);
    expect((await handler.onRead({ params: { uri: "async://" } })).contents[0]?.text).toBe("ok");
  });
});
