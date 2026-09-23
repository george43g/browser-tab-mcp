# Agent docs — index

The detail behind the root `AGENTS.md` router. Each file holds sections moved
verbatim from `AGENTS.md` on 2026-09-24, when George chose map-plus-docs
because Codex truncates project instructions at 32 KiB (BACKLOG B28, reopened).
The router says WHEN to read each one; this index says WHAT each holds.

| File | Sections |
|---|---|
| [architecture.md](architecture.md) | What This Repo Is (write-side control, `focus_tab` contract, journals, page content, screenshots, history, cgWindowId correlation, contract v2, platforms) · Stack · Workspace topology (kit packages) · Extension–daemon merge |
| [extension.md](extension.md) | Connector extension (Chrome + Safari) |
| [mcp-rules.md](mcp-rules.md) | MCP best practices · Post-step verification rule · Guardrails — the full reasoning behind the router's must-hold one-liners |
| [testing.md](testing.md) | Testing posture & taxonomy (incl. Effect coverage and the `macos-local` sweep) · Stress harness |
| [ci-release.md](ci-release.md) | CI / Release |
| [operations.md](operations.md) | Commands · Env layout · Self-healing watchdog · Process lifecycle · Logs · Troubleshooting · Cloud-agent specifics · MCP servers (project scope) |
| [native.md](native.md) | Native Rust acceleration (optional) |

Every file here is covered by
`apps/browser-tab-mcp/tests/docs-integrity.contract.test.ts`: its links and
backticked paths must resolve, it must be linked from `AGENTS.md`, and the
old `AGENTS.md` section headings must each still appear somewhere. Add a new
file here AND a routing line in `AGENTS.md`; a section no agent is routed to
is a deleted rule.
