import { getCodingToolsClient } from "./client";
import type { JsonObject } from "./contracts";

/**
 * Instant MCP Tools Managed App — UI-owned visual; Bot GG owns `app-handler/`.
 *
 * Do not add `app-handler/instant-mcp-tools/` from this lane. Host is
 * `codingTools.apps.call` / `invoke` (same IPC: `coding-tools:apps:call`).
 * In-process embed only: no listen-port Start and no installer/service restart.
 *
 * Primary operations (camelCase — call these from UI):
 *   inspect, listTools, listWorkspaces, runTool
 *
 * Kebab aliases (accept when present; GG follow-up):
 *   list-tools, run-tool
 *
 * @example
 * await codingTools.apps.call({ moduleId: "instant-mcp-tools", operation: "inspect" });
 * await codingTools.apps.call({
 *   moduleId: "instant-mcp-tools",
 *   operation: "listTools",
 *   arguments: { workspaceId },
 * });
 * await codingTools.apps.call({
 *   moduleId: "instant-mcp-tools",
 *   operation: "runTool",
 *   arguments: { tool, arguments: {}, workspaceId },
 * });
 */
export const INSTANT_MCP_TOOLS_MODULE_ID = "instant-mcp-tools" as const;

export const INSTANT_MCP_TOOLS_OPERATIONS = [
  "inspect",
  "listTools",
  "runTool",
  "listWorkspaces",
] as const;

/** @deprecated Use INSTANT_MCP_TOOLS_OPERATIONS (camelCase). Kebab aliases stay in INSTANT_MCP_TOOLS_KEBAB_ALIASES. */
export const INSTANT_MCP_TOOLS_EXPECTED_OPERATIONS = INSTANT_MCP_TOOLS_OPERATIONS;

export const INSTANT_MCP_TOOLS_KEBAB_ALIASES = {
  listTools: "list-tools",
  runTool: "run-tool",
} as const;

export type InstantMcpToolsModuleId = typeof INSTANT_MCP_TOOLS_MODULE_ID;
export type InstantMcpToolsOperation = typeof INSTANT_MCP_TOOLS_OPERATIONS[number];
export type InstantMcpToolsKebabAlias = typeof INSTANT_MCP_TOOLS_KEBAB_ALIASES[keyof typeof INSTANT_MCP_TOOLS_KEBAB_ALIASES];

export function kebabAliasFor(operation: InstantMcpToolsOperation): InstantMcpToolsKebabAlias | null {
  if (operation === "listTools" || operation === "runTool") {
    return INSTANT_MCP_TOOLS_KEBAB_ALIASES[operation];
  }
  return null;
}

export function unwrapAppsResult(payload: unknown): Record<string, unknown> {
  const wrapped = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const result = wrapped.result && typeof wrapped.result === "object" && !Array.isArray(wrapped.result)
    ? wrapped.result as Record<string, unknown>
    : {};
  return Object.keys(result).length > 0 ? result : wrapped;
}

export async function callInstantMcpTools(
  operation: InstantMcpToolsOperation,
  args: JsonObject = {},
): Promise<Record<string, unknown>> {
  const client = getCodingToolsClient();
  try {
    return unwrapAppsResult(await client.apps.call({
      moduleId: INSTANT_MCP_TOOLS_MODULE_ID,
      operation,
      arguments: args,
    }));
  } catch (cause) {
    const alias = kebabAliasFor(operation);
    if (!alias) throw cause;
    return unwrapAppsResult(await client.apps.call({
      moduleId: INSTANT_MCP_TOOLS_MODULE_ID,
      operation: alias,
      arguments: args,
    }));
  }
}
