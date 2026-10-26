import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";

export const CODEX_CHAT_SEND_WIRE_NAME = "mcp__codex_app__send_message_to_thread";

export const codexChatSendInputSchema = z.strictObject({
  turn_token: z.string().min(20).max(256),
  thread_id: z.string().min(1).max(256),
  prompt: z.string().min(1).max(5_000_000),
  host_id: z.string().min(1).max(256).optional(),
});

// Check the exact native identity before the shared gateway dispatches; suffix matches are unsafe.
export const CODEX_CHAT_SEND_GATEWAY_GUARD = [
  "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native chat tool registry is unavailable\");",
  `if (ALL_TOOLS.filter(tool => tool?.name === ${JSON.stringify(CODEX_CHAT_SEND_WIRE_NAME)}).length !== 1) throw new Error("Expected exactly one advertised official Codex chat sender");`,
].join("\n");

export function prepareCodexChatSend(
  tools: CodexTool[],
  input: z.infer<typeof codexChatSendInputSchema>,
): { tool: CodexTool | undefined; arguments: Record<string, unknown> } {
  const candidates = tools.filter(tool => namespacedToolName(tool.namespace, tool.name) === CODEX_CHAT_SEND_WIRE_NAME);
  if (candidates.length > 1) throw new Error("Expected exactly one advertised official Codex chat sender");
  const tool = candidates[0];
  if (tool?.freeform || tool?.toolSearch) throw new Error("Official Codex chat sender must be a structured function tool");
  return {
    tool,
    arguments: {
      threadId: input.thread_id,
      prompt: input.prompt,
      ...(input.host_id !== undefined ? { hostId: input.host_id } : {}),
    },
  };
}
