/**
 * Generic interactive REPL for driving an MCP dispatcher in-process.
 *
 * Lifted from imsg-mcp/src/cli.ts:58-201 and generalized. Takes a tool
 * dispatcher (any callable that returns `{ content: [{type:"text",text}], isError? }`)
 * and exposes:
 *   - `tools` / `?`   list available tools
 *   - `<tool> <json>` call a tool with JSON args
 *   - `raw <json>`    send raw {name, arguments} payload
 *   - `help`          show help
 *   - `quit` / `exit` exit
 *
 * No domain knowledge — each tool decides its own command shorthand by
 * registering custom shortcuts.
 */

import { createInterface, type Interface } from "node:readline";
import { color } from "./color.js";

export interface ToolCallResult {
  // Content blocks are MCP-shaped: text blocks carry `text`, media blocks
  // (e.g. images) carry `data`/`mimeType` instead — so `text` is optional.
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
}

export interface ReplDispatcher {
  listTools(): Promise<ToolDescriptor[]> | ToolDescriptor[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export interface ReplShortcut {
  /** Token typed by the user, e.g. `health`. */
  command: string;
  /** Tool name to invoke. */
  tool: string;
  /** Map positional args after the command into the tool's argument object. */
  buildArgs(args: string[]): Record<string, unknown>;
  /** Optional one-line description for `help`. */
  help?: string;
}

export interface RunReplOptions {
  prompt: string;
  dispatcher: ReplDispatcher;
  shortcuts?: ReplShortcut[];
  /** Greeting printed before the first prompt. */
  banner?: string;
  /** Stream of input to consume — defaults to process.stdin. Useful for tests. */
  input?: NodeJS.ReadableStream;
  /** Stream to write output to — defaults to process.stdout. */
  output?: NodeJS.WritableStream;
}

function parseConsoleInput(line: string): { cmd: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of line) {
    if ((char === '"' || char === "'") && quote == null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === " " && quote == null) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return { cmd: (parts[0] ?? "").toLowerCase(), args: parts.slice(1) };
}

async function printToolResult(out: NodeJS.WritableStream, result: ToolCallResult): Promise<void> {
  const text =
    result.content?.find((b) => typeof b.text === "string")?.text ??
    JSON.stringify(result, null, 2);
  if (result.isError) {
    out.write(`${color.red(text)}\n`);
    return;
  }
  out.write(`${text}\n`);
}

export async function runRepl(opts: RunReplOptions): Promise<void> {
  const out = opts.output ?? process.stdout;
  const inp = opts.input ?? process.stdin;
  const shortcuts = new Map<string, ReplShortcut>();
  for (const s of opts.shortcuts ?? []) {
    shortcuts.set(s.command, s);
  }

  if (opts.banner) {
    out.write(`${opts.banner}\n`);
  }

  const rl: Interface = createInterface({ input: inp, output: out });

  return new Promise<void>((resolveRepl) => {
    const prompt = () => {
      rl.question(color.cyan(`${opts.prompt}> `), async (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          prompt();
          return;
        }
        const { cmd, args } = parseConsoleInput(trimmed);

        try {
          if (cmd === "quit" || cmd === "exit") {
            rl.close();
            resolveRepl();
            return;
          }
          if (cmd === "help" || cmd === "?") {
            const tools = await opts.dispatcher.listTools();
            out.write(color.bold("Commands:\n"));
            out.write("  help, ?          Show this help\n");
            out.write("  tools            List MCP tools\n");
            out.write("  raw <json>       Send raw {name,arguments} payload\n");
            out.write("  quit, exit       Exit the REPL\n");
            for (const s of shortcuts.values()) {
              out.write(`  ${s.command}${s.help ? ` — ${s.help}` : ` (calls ${s.tool})`}\n`);
            }
            out.write(color.bold("\nAvailable MCP tools:\n"));
            for (const tool of tools) {
              out.write(`  ${tool.name}${tool.description ? ` — ${tool.description}` : ""}\n`);
            }
            prompt();
            return;
          }
          if (cmd === "tools") {
            for (const tool of await opts.dispatcher.listTools()) {
              out.write(`${tool.name}${tool.description ? ` — ${tool.description}` : ""}\n`);
            }
            prompt();
            return;
          }
          if (cmd === "raw") {
            if (args.length === 0) throw new Error("Usage: raw '<json>'");
            const parsed = JSON.parse(args.join(" ")) as {
              name?: string;
              arguments?: Record<string, unknown>;
            };
            if (!parsed.name) throw new Error('Expected: raw \'{"name":"tool","arguments":{}}\'');
            const r = await opts.dispatcher.callTool(parsed.name, parsed.arguments ?? {});
            await printToolResult(out, r);
            prompt();
            return;
          }

          const shortcut = shortcuts.get(cmd);
          if (shortcut) {
            const r = await opts.dispatcher.callTool(shortcut.tool, shortcut.buildArgs(args));
            await printToolResult(out, r);
            prompt();
            return;
          }

          throw new Error(`Unknown command: ${cmd}. Type 'help' for available commands.`);
        } catch (err) {
          out.write(`${color.red((err as Error).message)}\n`);
          prompt();
        }
      });
    };
    prompt();
  });
}
