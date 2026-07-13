# HTTP transport

The starter ships HTTP support wired up by default. Tools that don't want it can delete the relevant code in ~10 minutes; see "Removing HTTP support" below.

## Quick start

```bash
# Generate a token
export MCP_HTTP_TOKEN=$(openssl rand -hex 32)

# Run the server (port 8080, bind 127.0.0.1)
pnpm --filter @george43g/browser-tab-mcp http

# Or with explicit port/bind
pnpm --filter @george43g/browser-tab-mcp http -- --port 9090 --bind 0.0.0.0
```

## Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /mcp` | `Authorization: Bearer ${MCP_HTTP_TOKEN}` | MCP Streamable HTTP transport |
| `GET  /health` | none | Health snapshot for reverse-proxy probes; returns 503 if `unhealthy`, 200 otherwise |

## Connecting MCP hosts

Claude Code:
```bash
claude mcp add --transport http \
  --url https://browser-tab.example.com/mcp \
  --header "Authorization: Bearer $MCP_HTTP_TOKEN" \
  browser-tab-remote
```

OpenCode (`opencode.json`):
```json
{
  "mcp": {
    "browser-tab-remote": {
      "type": "remote",
      "url": "https://browser-tab.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_HTTP_TOKEN}" }
    }
  }
}
```

## Production deployment

- **TLS** is delegated to a reverse proxy (Caddy / nginx / Cloudflare Tunnel / Cloud Run). The MCP server binds to plain HTTP only.
- **Default bind is `127.0.0.1`** so direct Internet exposure requires an explicit `--bind 0.0.0.0` (or `MCP_HTTP_BIND=0.0.0.0`). Only do this when you're sure your network policy allows it.
- **Bearer token** is checked constant-time. Generate it with `openssl rand -hex 32` and store it in a secrets manager — never commit it.
- **Sessions** are stateful: the server hands out an `mcp-session-id` header on `initialize`; clients echo it on subsequent requests.
- **Single tenant** by design: one server process = one identity. Multi-tenant requires per-request OAuth introspection — out of scope for the starter.

## Health probing

Reverse proxies (and orchestration systems like Kubernetes) should probe `GET /health`. The endpoint returns:

- `200 OK` with `text/plain` body when status is `healthy` or `degraded`
- `503 Service Unavailable` when status is `unhealthy`

Body format matches `formatHealthText()` from `@george43g/robustness/health.ts` — multi-line text starting with `Status: healthy` / `degraded` / `unhealthy`.

## Removing HTTP support

If your tool only needs stdio:

1. Delete the `http` subcommand from `apps/browser-tab-mcp/src/cli.ts`.
2. Delete the `transport === "http"` branch from `apps/browser-tab-mcp/src/index.ts:runMcpServer`.
3. Delete case #9 (HTTP transport) from `apps/browser-tab-mcp/scripts/stress-mcp.ts`.
4. Remove `MCP_HTTP_TOKEN`, `MCP_HTTP_PORT`, `MCP_HTTP_BIND` from `.env.example`.
5. Optionally delete `packages/mcp-kit/src/transports/http.ts` if no other tool in your workspace uses it.

The `pnpm stress` harness will still pass — case #9 just runs one fewer assertion.
