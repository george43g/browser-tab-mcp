/**
 * MCP Resources — the second handler shape MCP clients can talk to.
 *
 * Tools run a verb ("call this function"). Resources expose addressable
 * read-only state ("read this URI"). Hosts can subscribe to resources or
 * browse them without re-invoking tools — useful for log streams, health
 * snapshots, document content, etc.
 *
 * This kit mirrors the spec's two request shapes:
 *
 *   - ListResourcesRequest / ListResourcesResult     (concrete URIs)
 *   - ListResourceTemplatesRequest / ...Result       (URI templates)
 *   - ReadResourceRequest / ReadResourceResult       (resolve a URI)
 *
 * Consumers wire the returned `{ onList, onListTemplates, onRead }` into
 * `server.setRequestHandler(...)`. Each callback handles its own error
 * shape per the SDK contract.
 *
 * INVARIANT: like the tools dispatcher, every read goes through a perf
 * span + structured error wrap. Never throw bare errors; the caller can
 * inspect `error.message` for the resource URI + hint.
 */

import { perf } from "@george43g/robustness";
import { wrapToolError } from "./prompt-injection.js";

/** A directly-addressable resource (URI is the full address). */
export interface ResourceListEntry {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** A URI template (e.g. "logs://recent/{n}") clients fill in to read. */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Returned by the read callback when the URI is resolved. */
export interface ResourceContent {
  uri: string;
  mimeType: string;
  /** UTF-8 text body. Mutually exclusive with `blob`. */
  text?: string;
  /** base64-encoded binary body. Mutually exclusive with `text`. */
  blob?: string;
}

export interface ResourcesProvider {
  /** Concrete resources to expose; default: none. */
  list?(): Promise<ResourceListEntry[]> | ResourceListEntry[];
  /** URI templates to expose; default: none. */
  listTemplates?(): Promise<ResourceTemplate[]> | ResourceTemplate[];
  /**
   * Resolve a URI. Throw if unknown — the wrapper turns it into a
   * structured error the SDK propagates to the client.
   */
  read(uri: string): Promise<ResourceContent> | ResourceContent;
}

export interface BuildResourcesHandlerOptions {
  provider: ResourcesProvider;
  /** Optional engine label surfaced in perf spans. */
  engineLabel?: string;
}

export interface ResourceHandlers {
  /** Wire into `server.setRequestHandler(ListResourcesRequestSchema, ...)`. */
  onList(): Promise<{ resources: ResourceListEntry[] }>;
  /** Wire into `server.setRequestHandler(ListResourceTemplatesRequestSchema, ...)`. */
  onListTemplates(): Promise<{ resourceTemplates: ResourceTemplate[] }>;
  /** Wire into `server.setRequestHandler(ReadResourceRequestSchema, ...)`. */
  onRead(request: { params: { uri: string } }): Promise<{ contents: ResourceContent[] }>;
}

export function buildResourcesHandler(opts: BuildResourcesHandlerOptions): ResourceHandlers {
  const { provider, engineLabel = "ts" } = opts;

  async function onList() {
    const span = perf("resources.list");
    try {
      const resources = provider.list ? await provider.list() : [];
      return { resources };
    } finally {
      span.end();
    }
  }

  async function onListTemplates() {
    const span = perf("resources.listTemplates");
    try {
      const resourceTemplates = provider.listTemplates ? await provider.listTemplates() : [];
      return { resourceTemplates };
    } finally {
      span.end();
    }
  }

  async function onRead(request: { params: { uri: string } }) {
    const uri = request.params.uri;
    const span = perf(`resources.read[${engineLabel}]`);
    try {
      const content = await provider.read(uri);
      return { contents: [content] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // wrapToolError produces a structured shape with an actionable
      // hint — same pattern the tools dispatcher uses.
      throw new Error(wrapToolError(`resources/read`, msg, `Unknown resource URI: "${uri}"`));
    } finally {
      span.end();
    }
  }

  return { onList, onListTemplates, onRead };
}
