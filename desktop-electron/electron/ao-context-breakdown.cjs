"use strict";

// The context panel's split of an agent's context by category, as Claude Code's /context shows
// one (system prompt and tools, messages, tool calls, free space). Agents report only the total
// in use, so the split is estimated from AO's own copy of the conversation since the last
// compaction: the messages' and tool calls' text is counted, and what the agent reports beyond
// that is its system prompt, tool definitions and memory files. AO keeps tool output trimmed, so
// the counted parts are a floor and the remainder a ceiling; the panel says it is an estimate.

const PAGE = 500;
const MAX_PAGES = 8;

/** About how many tokens a text costs: ~4 characters each for Latin script, ~1 each for CJK
 * and other wide scripts (what BPE tokenizers average). */
function estimateTokens(text) {
  if (typeof text !== "string" || !text) return 0;
  let narrow = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 0x2e80) narrow += 1;
    else wide += 1;
  }
  return Math.ceil(narrow / 4) + wide;
}

const jsonText = (value) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return ""; }
};

/** The text a timeline activity put into the agent's context; reasoning is left out because
 * agents drop earlier turns' thinking from what they send back. */
function activityText(activity) {
  const detail = activity?.detail && typeof activity.detail === "object" ? activity.detail : {};
  switch (activity?.activityKind) {
    case "command": return `${jsonText(detail.command ?? detail.rawCommand)}\n${jsonText(detail.output)}`;
    // ACP tool calls carry `input` and `output` or `content` blocks (what timelineActivity reads);
    // Codex's MCP calls carry `arguments` and `result`.
    case "mcp_tool": {
      const content = (Array.isArray(detail.content) ? detail.content : []).map((entry) => entry?.content?.text ?? entry?.text)
        .filter((text) => typeof text === "string").join("\n");
      return [detail.toolName, detail.input ?? detail.arguments, detail.output, content, detail.result, detail.error]
        .map(jsonText).filter(Boolean).join("\n");
    }
    case "file_change": return (Array.isArray(detail.files) ? detail.files : []).map((file) => `${jsonText(file?.path)}\n${jsonText(file?.patch)}`).join("\n");
    case "user_input": return jsonText(detail.message);
    default: return "";
  }
}

const isCompaction = (activity) => activity?.activityKind === "system" && activity?.detail?.event === "compaction";

/**
 * Splits `usage.contextUsed` into categories from the timeline entries since the last
 * compaction. `entries` are the snapshot's messages and activities (any order). Returns null
 * when the agent has not reported how much context it uses.
 */
function contextBreakdown({ messages = [], activities = [], usage, complete = true }) {
  const used = Number.isFinite(usage?.contextUsed) && usage.contextUsed > 0 ? usage.contextUsed : null;
  if (used === null) return null;
  const window = Number.isFinite(usage?.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
  const since = activities.filter(isCompaction).reduce((latest, activity) => Math.max(latest, Number(activity.sequence) || 0), 0);
  const after = (entry) => (Number(entry?.sequence) || 0) > since;
  let messageTokens = 0;
  let messageCount = 0;
  for (const message of messages) {
    if (!after(message)) continue;
    messageTokens += estimateTokens(message?.text);
    messageCount += 1;
  }
  let toolTokens = 0;
  let toolCount = 0;
  for (const activity of activities) {
    if (!after(activity)) continue;
    const tokens = estimateTokens(activityText(activity));
    if (!tokens) continue;
    toolTokens += tokens;
    toolCount += 1;
  }
  // The text counts can exceed what the agent reports (a long output it never read in full, a
  // tokenizer cheaper than four characters a token): then the two share the reported total.
  const counted = messageTokens + toolTokens;
  if (counted > used) {
    messageTokens = Math.round(used * (messageTokens / counted));
    toolTokens = used - messageTokens;
  }
  const system = Math.max(0, used - messageTokens - toolTokens);
  return {
    used,
    window,
    free: window === null ? null : Math.max(0, window - used),
    categories: [
      { id: "system", label: "System prompt & tools", tokens: system },
      { id: "tools", label: "Tool calls & results", tokens: toolTokens },
      { id: "messages", label: "Messages", tokens: messageTokens },
    ],
    counts: { messages: messageCount, toolCalls: toolCount },
    sinceCompaction: since > 0,
    complete,
  };
}

/**
 * Reads a session's timeline back to its last compaction (at most MAX_PAGES pages) and splits
 * its reported context. `get(query)` fetches one page of `/conversation`.
 */
async function readContextBreakdown(get, usage) {
  const messages = [];
  const activities = [];
  let before = null;
  let complete = true;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) { complete = false; break; }
    const snapshot = await get(`limit=${PAGE}${before ? `&beforeSequence=${before}` : ""}`);
    if (!snapshot || typeof snapshot !== "object") { complete = page > 0 && complete; break; }
    const pageMessages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const pageActivities = Array.isArray(snapshot.activities) ? snapshot.activities : [];
    messages.push(...pageMessages);
    activities.push(...pageActivities);
    if (pageActivities.some(isCompaction) || !snapshot.hasMoreBefore) break;
    const oldest = Number(snapshot.oldestSequence);
    if (!Number.isFinite(oldest) || oldest <= 1 || (before !== null && oldest >= before)) break;
    before = oldest;
  }
  return contextBreakdown({ messages, activities, usage, complete });
}

module.exports = { estimateTokens, contextBreakdown, readContextBreakdown };
