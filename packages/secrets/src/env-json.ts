/**
 * env-JSON source: read a full JSON payload from a single env var.
 *
 * The primary path for CI / Docker / k8s — operators inject the secret as a
 * GitHub secret / k8s Secret / cloud-run env var and the tool runs with zero
 * filesystem state.
 *
 * Env var name: `{TOOL_PREFIX}_{NAME}_JSON`, e.g. `FOO_MCP_CREDENTIALS_JSON`.
 * Plain string fallback: `{TOOL_PREFIX}_{NAME}` (when the secret is a single
 * token rather than structured JSON).
 */

import type { SecretRef, SecretSource } from "./types.js";

function envKey(ref: SecretRef, suffix: string): string {
  return `${ref.toolPrefix.toUpperCase().replace(/-/g, "_")}_${ref.name.toUpperCase()}${suffix}`;
}

export const envJsonSource: SecretSource = {
  name: "env-json",
  async resolve(ref: SecretRef): Promise<string | null> {
    const jsonKey = envKey(ref, "_JSON");
    const plainKey = envKey(ref, "");
    const jsonRaw = process.env[jsonKey];
    if (jsonRaw && jsonRaw.length > 0) return jsonRaw;
    const plainRaw = process.env[plainKey];
    if (plainRaw && plainRaw.length > 0) return plainRaw;
    return null;
  },
};
