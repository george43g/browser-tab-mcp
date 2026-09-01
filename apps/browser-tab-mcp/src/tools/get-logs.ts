/**
 * get_logs — dev-only inspector for the AI agent.
 *
 * Registered ONLY when MCP_DEV=1 is set. Exposes the in-process log ring
 * buffer + (optionally) the NDJSON file on disk so the AI agent can
 * inspect its own performance and errors without leaving the chat.
 *
 * Kept gated because:
 *   - Log lines can contain absolute file paths (mild info leak)
 *   - Exposing it in production gives the LLM a richer error feedback
 *     loop than most users want
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { getFileLogLines, getLogs } from "@george43g/robustness";
import { GetLogsInputSchema, GetLogsOutputSchema } from "@george43g/shared-types";

export const getLogsTool: ToolDefinition<typeof GetLogsInputSchema, typeof GetLogsOutputSchema> = {
  name: "get_logs",
  description:
    "Return recent log lines from the MCP server. Source: 'memory' (in-process ring buffer, " +
    "fastest), 'file' (NDJSON on disk, persists across restarts), or 'all' (concatenated). " +
    "Dev-only: registered only when MCP_DEV=1.",
  input: GetLogsInputSchema,
  output: GetLogsOutputSchema,
  annotations: {
    title: "Read server logs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  devOnly: true,
  timeoutMs: 5000,
  handler: async ({ tail, source }) => {
    const lines: string[] = [];
    if (source === "memory" || source === "all") {
      lines.push(...getLogs(tail));
    }
    if (source === "file" || source === "all") {
      if (source === "all") lines.push("--- file ---");
      lines.push(...getFileLogLines(tail));
    }
    return { source, lines };
  },
};
