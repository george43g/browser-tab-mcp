/**
 * 1Password source: resolve `op://Vault/Item/field` references via the
 * `op` CLI. Optional — gracefully degrades when the CLI is not installed
 * or the user is not signed in.
 *
 * The reference itself is read from `{TOOL_PREFIX}_{NAME}_OP` env var.
 * Example: `FOO_MCP_CREDENTIALS_OP=op://Personal/Foo MCP/credentials`.
 *
 * Spawning a subprocess per resolve is fine — secrets are loaded once at
 * startup, not on the hot path.
 */

import { execFileSync } from "node:child_process";
import type { SecretRef, SecretSource } from "./types.js";

function envKey(ref: SecretRef): string {
  return `${ref.toolPrefix.toUpperCase().replace(/-/g, "_")}_${ref.name.toUpperCase()}_OP`;
}

function looksLikeOpRef(s: string): boolean {
  return s.startsWith("op://");
}

export const onepasswordSource: SecretSource = {
  name: "1password",
  async resolve(ref: SecretRef): Promise<string | null> {
    const opRef = process.env[envKey(ref)];
    if (!opRef || !looksLikeOpRef(opRef)) return null;

    try {
      const out = execFileSync("op", ["read", opRef], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      // op CLI missing, user not signed in, vault locked, or reference invalid.
      // Degrade silently — the chain will fall through to the next source.
      return null;
    }
  },
};
