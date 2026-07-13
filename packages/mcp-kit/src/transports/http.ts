/**
 * Streamable HTTP transport.
 *
 * Lifted from Gmail-MCP-Server/src/server/http.ts with the bearer-token env
 * var made caller-supplied (default: MCP_HTTP_TOKEN). Single-tenant by
 * design — one server process = one identity. Multi-tenant is a future
 * enhancement; out of scope for the template.
 *
 * - POST /mcp   — MCP protocol (bearer-token required)
 * - GET  /health — health snapshot (no auth; for reverse-proxy probes;
 *                 returns 503 if unhealthy)
 *
 * TLS is delegated to a reverse proxy. Default bind is 127.0.0.1.
 *
 * The bearer-token check is constant-time to prevent timing attacks.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import { formatHealthText, snapshotHealth } from "@george43g/robustness";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface HttpServerOptions {
  server: McpServer;
  port: number;
  bind: string;
  /** Env var name containing the bearer token. Default: "MCP_HTTP_TOKEN". */
  tokenEnv?: string;
  getCounters: () => { toolCalls: number; recentErrors: number };
  log?: (line: string) => void;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  port: number;
  url: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

export async function startHttpServer(opts: HttpServerOptions): Promise<HttpServerHandle> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const tokenEnv = opts.tokenEnv ?? "MCP_HTTP_TOKEN";

  const expectedToken = process.env[tokenEnv];
  if (!expectedToken || expectedToken.trim().length === 0) {
    throw new Error(
      `HTTP mode requires ${tokenEnv} to be set to a non-empty bearer token. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // The SDK's Transport interface declares optional callbacks as required
  // fields under `exactOptionalPropertyTypes`. Connect via a structural cast.
  await opts.server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      if (method === "GET" && (url === "/health" || url.startsWith("/health?"))) {
        const snap = snapshotHealth(opts.getCounters());
        res.writeHead(snap.status === "unhealthy" ? 503 : 200, {
          "content-type": "text/plain; charset=utf-8",
        });
        res.end(formatHealthText(snap));
        return;
      }

      if (!url.startsWith("/mcp")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found. Use POST /mcp for MCP requests, GET /health for status.");
        return;
      }

      const authHeader = (req.headers.authorization ?? "").trim();
      const provided = authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : "";
      if (!provided || !timingSafeEqual(provided, expectedToken)) {
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "www-authenticate": 'Bearer realm="mcp"',
        });
        res.end("Unauthorized. Provide an Authorization: Bearer <token> header.");
        return;
      }

      let body: unknown;
      if (method === "POST") {
        body = await readJsonBody(req);
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      const e = err as Error;
      log(`http_error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Internal error: ${e.message}`);
      } else {
        try {
          res.end();
        } catch {
          // swallow
        }
      }
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(opts.port, opts.bind, () => {
      httpServer.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
  const url = `http://${opts.bind}:${actualPort}`;
  log(`MCP HTTP listening on ${url}`);
  log(`  POST ${url}/mcp     — MCP Streamable HTTP (Authorization: Bearer required)`);
  log(`  GET  ${url}/health  — health snapshot (no auth)`);

  return {
    port: actualPort,
    url,
    async close() {
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
      await transport.close();
    },
  };
}
