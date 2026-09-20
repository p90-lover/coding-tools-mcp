/**
 * Instant MCP Tools — UI-owned Managed App contract notes.
 *
 * This lane hosts the visual in-process (no listen-port Start). Bot GG owns
 * `app-handler/` registration. Do not add `app-handler/instant-mcp-tools/` from
 * the UI lane; keep MODULE_IDS as CPA / Router / CommandCode / Paseo / Anneal
 * until that handler lands.
 *
 * Existing, already-wired surface (callable today):
 *   apps_list  → codingTools.apps.list()
 *   run tool   → codingTools.tools.call({ workspaceId, tool, arguments })
 *
 * Expected Bot GG handler when it lands (same IPC, no new ports):
 *   codingTools.apps.call({ moduleId: "instant-mcp-tools", operation: "inspect" })
 *   codingTools.apps.call({ moduleId: "instant-mcp-tools", operation: "list-tools" })
 *   codingTools.apps.call({ moduleId: "instant-mcp-tools", operation: "run-tool", arguments })
 */
export const INSTANT_MCP_TOOLS_MODULE_ID = "instant-mcp-tools" as const;

export const INSTANT_MCP_TOOLS_EXPECTED_OPERATIONS = [
  "inspect",
  "list-tools",
  "run-tool",
] as const;

export type InstantMcpToolsModuleId = typeof INSTANT_MCP_TOOLS_MODULE_ID;
export type InstantMcpToolsOperation = typeof INSTANT_MCP_TOOLS_EXPECTED_OPERATIONS[number];
