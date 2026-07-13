import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEnvFromFlags, bindEnvFlags, type EnvFlagBinding } from "./env-flag-binder.js";

const bindings: EnvFlagBinding[] = [
  { envVar: "MCP_LOG_DIR", description: "Log directory" },
  { envVar: "MCP_MAX_RSS_MB", description: "Max RSS in MB" },
  { envVar: "STARTER_HTTP_TOKEN", description: "HTTP bearer token" },
  { envVar: "MCP_DEV", description: "Dev mode", boolean: true },
];

function buildAndParse(argv: string[]): Command {
  const program = new Command();
  program.exitOverride(); // don't process.exit on help/version in tests
  bindEnvFlags(program, bindings, { stripPrefixes: ["STARTER_", "MCP_"] });
  program.parse(argv, { from: "user" });
  return program;
}

beforeEach(() => {
  delete process.env.MCP_LOG_DIR;
  delete process.env.MCP_MAX_RSS_MB;
  delete process.env.STARTER_HTTP_TOKEN;
  delete process.env.MCP_DEV;
});

afterEach(() => {
  delete process.env.MCP_LOG_DIR;
  delete process.env.MCP_MAX_RSS_MB;
  delete process.env.STARTER_HTTP_TOKEN;
  delete process.env.MCP_DEV;
});

describe("bindEnvFlags + applyEnvFromFlags", () => {
  it("registers string flags derived from env-var names", () => {
    const program = buildAndParse(["--log-dir", "/tmp/test"]);
    const opts = program.opts<{ logDir?: string }>();
    expect(opts.logDir).toBe("/tmp/test");
  });

  it("registers boolean flags", () => {
    const program = buildAndParse(["--dev"]);
    const opts = program.opts<{ dev?: boolean }>();
    expect(opts.dev).toBe(true);
  });

  it("applies string flag values back to process.env", () => {
    const program = buildAndParse(["--log-dir", "/tmp/log", "--max-rss-mb", "256"]);
    applyEnvFromFlags(program, bindings, { stripPrefixes: ["STARTER_", "MCP_"] });
    expect(process.env.MCP_LOG_DIR).toBe("/tmp/log");
    expect(process.env.MCP_MAX_RSS_MB).toBe("256");
  });

  it("applies boolean flag as '1'", () => {
    const program = buildAndParse(["--dev"]);
    applyEnvFromFlags(program, bindings, { stripPrefixes: ["STARTER_", "MCP_"] });
    expect(process.env.MCP_DEV).toBe("1");
  });

  it("strips longest matching prefix from env-var name", () => {
    const program = buildAndParse(["--http-token", "abc123"]);
    applyEnvFromFlags(program, bindings, { stripPrefixes: ["STARTER_", "MCP_"] });
    expect(process.env.STARTER_HTTP_TOKEN).toBe("abc123");
  });

  it("leaves env untouched when flag not provided", () => {
    process.env.MCP_LOG_DIR = "/preexisting";
    const program = buildAndParse([]);
    applyEnvFromFlags(program, bindings, { stripPrefixes: ["STARTER_", "MCP_"] });
    expect(process.env.MCP_LOG_DIR).toBe("/preexisting");
  });
});
