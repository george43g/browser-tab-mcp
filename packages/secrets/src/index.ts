/**
 * Public entrypoint for @george43g/secrets.
 *
 * Default chain: env-json → 1Password → file.
 *
 * Apple Keychain support is deliberately omitted from the starter template.
 * If a tool needs it, add a `keychain.ts` source and place it in the chain
 * after `env-json` and before `1password`.
 *
 * Usage:
 *   const secret = await loadSecret({
 *     name: "credentials",
 *     toolPrefix: "browser-tab",
 *   });
 *   const json = JSON.parse(secret.value);
 */

import { envJsonSource } from "./env-json.js";
import { fileSource } from "./file.js";
import { onepasswordSource } from "./onepassword.js";
import {
  MissingSecretError,
  type ResolvedSecret,
  type SecretRef,
  type SecretSource,
} from "./types.js";

export { envJsonSource } from "./env-json.js";
export { fileSource } from "./file.js";
export { onepasswordSource } from "./onepassword.js";
export type { ResolvedSecret, SecretRef, SecretSource, SecretSourceName } from "./types.js";
export { MissingSecretError } from "./types.js";

export const defaultSources: SecretSource[] = [envJsonSource, onepasswordSource, fileSource];

export interface LoadSecretOptions {
  /** Override the source chain. Defaults to `defaultSources`. */
  sources?: SecretSource[];
  /** Throw MissingSecretError if no source resolves. Defaults to true. */
  required?: boolean;
}

export async function loadSecret(
  ref: SecretRef,
  opts: LoadSecretOptions = {},
): Promise<ResolvedSecret | null> {
  const sources = opts.sources ?? defaultSources;
  for (const source of sources) {
    const value = await source.resolve(ref);
    if (value !== null) {
      return { value, source: source.name };
    }
  }
  if (opts.required !== false) {
    throw new MissingSecretError(ref);
  }
  return null;
}
