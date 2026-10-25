import { createHash } from "node:crypto";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

function messageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(block => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

/** Native compaction remains part of the exact identity of a replayed Codex turn. */
function compactionEpoch(input: unknown[] | undefined): unknown {
  return input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return record.type === "compaction"
      || record.type === "compaction_summary"
      || record.type === "context_compaction"
      || (record.role === "user" && messageText(record)?.startsWith(`${SUMMARY_PREFIX}\n`));
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    compaction: compactionEpoch(raw?.input),
    // Changed Codex instructions start a new conversation, which receives them in full.
    instructions: createHash("sha256").update(JSON.stringify(parsed.context.systemPrompt ?? [])).digest("hex"),
  })).digest("hex");
}

/**
 * Full history remains canonical; a retained epoch receives only the suffix after its last
 * assistant reply. The retained ChatGPT conversation already holds the Codex instructions from
 * its first turn, and the conversation key changes if they change, so they are not re-sent.
 */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  const messages = parsed.context.messages;
  const lastAssistant = messages.findLastIndex(message => message.role === "assistant");
  // Steering can append a second user instruction while the first answer is still streaming.
  // That earlier user prompt is already in the retained ChatGPT tab. Include only the new
  // instruction and any tool results since it; never post the previous prompt twice.
  const latestUser = messages.findLastIndex(message => message.role === "user");
  const previousUser = messages.findLastIndex((message, index) => index < latestUser && message.role === "user");
  const from = previousUser > lastAssistant ? previousUser + 1 : lastAssistant + 1;
  if (from <= 0 || from >= messages.length) return undefined;
  const { systemPrompt: _sentWithTheFirstTurn, ...context } = parsed.context;
  return {
    ...parsed,
    context: {
      ...context,
      messages: messages.slice(from),
    },
  };
}
