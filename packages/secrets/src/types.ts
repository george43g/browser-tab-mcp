/**
 * Public types for the secrets package.
 *
 * A SecretSource is anything that can resolve a SecretRef into a string
 * (or null if it can't). The library composes a chain of sources and
 * returns the first hit.
 */

export interface SecretRef {
  /** Logical name — used as env-var stem (UPPER_SNAKE) and 1Password item title. */
  name: string;
  /** Tool name prefix, e.g. "browser-tab". Used to namespace env vars and config dirs. */
  toolPrefix: string;
  /** Optional 1Password section/field if the secret lives inside a structured item. */
  opField?: string;
}

export interface ResolvedSecret {
  value: string;
  source: SecretSourceName;
}

export type SecretSourceName = "env-json" | "1password" | "file" | "env-plain";

export interface SecretSource {
  name: SecretSourceName;
  resolve(ref: SecretRef): Promise<string | null>;
}

export class MissingSecretError extends Error {
  constructor(public readonly ref: SecretRef) {
    super(
      `Secret "${ref.name}" not found in any configured source. ` +
        `Set ${ref.toolPrefix.toUpperCase()}_${ref.name.toUpperCase()}_JSON, ` +
        `${ref.toolPrefix.toUpperCase()}_${ref.name.toUpperCase()}_OP, or place a file at ` +
        `~/.${ref.toolPrefix}/${ref.name}.json.`,
    );
    this.name = "MissingSecretError";
  }
}
