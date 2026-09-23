/** Types for mcp-apps.mjs (adopted from mcp-cli-starter-template; plain ESM so CI and tests share one file). */

export declare const MCP_MARKER: string;
export declare const REPO_ROOT: string;

export interface McpApp {
  /** Repo-relative directory, e.g. `apps/tmux-control-mcp`. */
  dir: string;
  /** Package name, what `pnpm --filter` addresses. */
  name: string;
}

export declare function mcpApps(root?: string): { apps: McpApp[]; unnamed: string[] };
export declare function requireMcpApps(who: string, root?: string): McpApp[];
