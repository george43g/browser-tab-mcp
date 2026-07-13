import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecret, MissingSecretError, type SecretRef, type SecretSource } from "./index.js";

const TOOL = "starter";
const NAME = "credentials";
const JSON_KEY = `${TOOL.toUpperCase()}_${NAME.toUpperCase()}_JSON`;
const PLAIN_KEY = `${TOOL.toUpperCase()}_${NAME.toUpperCase()}`;
const OP_KEY = `${TOOL.toUpperCase()}_${NAME.toUpperCase()}_OP`;
const PATH_KEY = `${TOOL.toUpperCase()}_${NAME.toUpperCase()}_PATH`;

const ref: SecretRef = { name: NAME, toolPrefix: TOOL };

function clearKeys() {
  delete process.env[JSON_KEY];
  delete process.env[PLAIN_KEY];
  delete process.env[OP_KEY];
  delete process.env[PATH_KEY];
}

describe("loadSecret chain", () => {
  beforeEach(clearKeys);
  afterEach(clearKeys);

  it("resolves env-json when set", async () => {
    process.env[JSON_KEY] = '{"token":"abc"}';
    const resolved = await loadSecret(ref);
    expect(resolved).toEqual({ value: '{"token":"abc"}', source: "env-json" });
  });

  it("resolves plain env as fallback when JSON key is empty", async () => {
    process.env[PLAIN_KEY] = "plain-token";
    const resolved = await loadSecret(ref);
    expect(resolved).toEqual({ value: "plain-token", source: "env-json" });
  });

  it("returns null with required:false when no source matches", async () => {
    const resolved = await loadSecret(ref, { required: false });
    expect(resolved).toBeNull();
  });

  it("throws MissingSecretError by default when no source matches", async () => {
    await expect(loadSecret(ref)).rejects.toBeInstanceOf(MissingSecretError);
  });

  it("honors custom source chain order", async () => {
    process.env[JSON_KEY] = "from-env";
    const stub: SecretSource = {
      name: "1password",
      async resolve() {
        return "from-stub";
      },
    };
    const resolved = await loadSecret(ref, { sources: [stub] });
    expect(resolved?.value).toBe("from-stub");
  });
});
