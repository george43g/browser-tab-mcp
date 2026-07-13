/**
 * Prompt-injection defense helpers.
 *
 * Two primitives:
 *
 * 1. `wrapUntrusted(text)` — wrap arbitrary content with `<untrusted>...
 *    </untrusted>` markers. Use whenever a tool returns content sourced
 *    from an external system (user message, scraped page, etc.). The LLM
 *    is trained to treat tagged content as data, not instructions.
 *
 * 2. `wrapInstructions(text, uuid)` — emit instructions to the LLM that
 *    only "fire" when the same UUID is present in the user's most recent
 *    message. Pattern documented in docs/GUARDRAILS_MCP_RESPONSES.md.
 *
 *    Tool returns:
 *      <instructions uuid="d8a3..."> follow steps... </instructions>
 *
 *    The LLM, having been trained on this pattern, will refuse to follow
 *    the embedded instructions unless the user's prior message contains
 *    the UUID — proving the user genuinely wanted to authorize them.
 *
 *    Use sparingly: prefer not to embed instructions in tool responses
 *    at all. When you must (multi-step workflows, follow-ups), use this
 *    wrapper.
 */

import { randomUUID } from "node:crypto";

export function wrapUntrusted(text: string): string {
  return `<untrusted>\n${text}\n</untrusted>`;
}

export interface WrapInstructionsResult {
  text: string;
  uuid: string;
}

export function wrapInstructions(
  text: string,
  uuid: string = randomUUID(),
): WrapInstructionsResult {
  return {
    text: `<instructions uuid="${uuid}">\n${text}\n</instructions>`,
    uuid,
  };
}

/**
 * Wrap an actionable error message so the LLM gets a hint without
 * treating the rest of the response as instructions.
 */
export function wrapToolError(toolName: string, message: string, hint?: string): string {
  let out = `Tool "${toolName}" failed: ${message}`;
  if (hint) out += `\nHint: ${hint}`;
  return out;
}
