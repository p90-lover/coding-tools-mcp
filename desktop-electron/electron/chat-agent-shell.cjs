"use strict";

// The chat Terminal pane's view of the shell commands a chat agent ran with its own tool (Claude
// Code's Bash/PowerShell over ACP, Codex's shell), next to the ones it started through the app's
// exec_command. AO records each as a conversation activity: an ACP "execute" call and a Codex
// command are activityKind "command" with detail.command (and rawCommand), detail.output (streamed
// terminal output folded in by AO), detail.exitCode and, for Codex, detail.cwd; older ACP builds
// report the call as "mcp_tool" with input.command. Read-only: the app neither types into nor
// stops these, the agent's own process owns them.

const MAX_AGENT_COMMANDS = 40;
const MAX_COMMAND_BYTES = 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_SESSIONS = 8;
// What AO reads back per poll: the newest items of the conversation (messages and activities).
const CONVERSATION_LIMITS = [60, 20];

function utf8Prefix(text, maxBytes) {
  const value = String(text);
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end = Math.floor(end * 0.95);
  while (end < value.length && Buffer.byteLength(value.slice(0, end + 1), "utf8") <= maxBytes) end += 1;
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** The longest suffix of `text` that is at most `maxBytes` of UTF-8: a command's newest output. */
function utf8Suffix(text, maxBytes) {
  const value = String(text);
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let start = Math.max(0, value.length - maxBytes);
  while (start < value.length && Buffer.byteLength(value.slice(start), "utf8") > maxBytes) start = Math.ceil(start + (value.length - start) * 0.05);
  while (start > 0 && Buffer.byteLength(value.slice(start - 1), "utf8") <= maxBytes) start -= 1;
  // Never start on the second half of a surrogate pair.
  const first = value.charCodeAt(start);
  if (start < value.length && first >= 0xdc00 && first <= 0xdfff) start += 1;
  return value.slice(start);
}

// A tool of a real MCP server (mcp__<server>__<tool>, the app's own exec_command among them) is
// not the agent's shell; claude-agent-acp names its built-in tools mcp__acp__.
const MCP_SERVER_TOOL = /^mcp__(?!acp__)/;

function commandText(activity, detail, input) {
  if (activity.activityKind === "command") {
    for (const value of [detail.command, input.command, detail.rawCommand]) {
      if (typeof value === "string" && value.trim()) return value.trim();
      if (Array.isArray(value) && value.length && value.every((part) => typeof part === "string")) return value.join(" ").trim();
    }
    return "";
  }
  if (activity.activityKind !== "mcp_tool" || typeof input.command !== "string" || !input.command.trim()) return "";
  const name = String(detail.toolName || detail.providerToolName || "");
  if (MCP_SERVER_TOOL.test(name) || MCP_SERVER_TOOL.test(String(activity.summary || "")) || typeof detail.server === "string") return "";
  return input.command.trim();
}

function outputText(detail) {
  let output = typeof detail.output === "string" && detail.output ? detail.output
    : (Array.isArray(detail.content) ? detail.content : [])
      .map((entry) => entry?.content?.text).filter((text) => typeof text === "string").join("\n");
  // claude-agent-acp wraps a Bash result in a Markdown code fence.
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(output);
  if (fenced) output = fenced[1];
  return utf8Suffix(output, MAX_OUTPUT_BYTES);
}

const RUNNING = new Set(["running", "pending"]);
const warned = new Map();

/** The agent's own shell commands in an AO conversation, newest first, as Terminal pane entries. */
function agentShellCommands(conversation, limit = MAX_AGENT_COMMANDS) {
  const activities = Array.isArray(conversation?.activities) ? conversation.activities : [];
  const entries = [];
  for (const activity of activities) {
    if (!activity || typeof activity !== "object" || activity.id === undefined || activity.id === null) continue;
    const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
    const input = detail.input && typeof detail.input === "object" ? detail.input : {};
    const command = commandText(activity, detail, input);
    if (!command) continue;
    const status = String(activity.status || "").slice(0, 32);
    const running = RUNNING.has(status);
    const exitCode = Number.isInteger(detail.exitCode) ? detail.exitCode : null;
    const startedAt = Date.parse(activity.createdAt ?? "") || Date.parse(activity.updatedAt ?? "") || 0;
    const cmd = utf8Prefix(command, MAX_COMMAND_BYTES);
    entries.push({
      id: `agent:${String(activity.id).slice(0, 200)}`, cmd, command: cmd,
      workdir: typeof detail.cwd === "string" ? detail.cwd.slice(0, 1024) : "",
      startedAt, status: running ? "running" : status || "completed", running, exitCode,
      output: outputText(detail), source: "agent", sequence: Number(activity.sequence) || 0,
    });
  }
  return entries
    .sort((left, right) => right.sequence - left.sequence || right.startedAt - left.startedAt)
    .slice(0, limit)
    .map(({ sequence: _sequence, ...entry }) => entry);
}

/**
 * The Terminal pane's listing: each session's app commands (from chat-agent-tools processes(),
 * marked source "app") with the agent's own shell commands read from its AO conversation. A
 * conversation that cannot be read is logged and left out; the app's listing always stands.
 */
async function withAgentShellCommands(appSessions, sessionIds, readConversation, logger = console) {
  const listed = Array.isArray(appSessions) ? appSessions : [];
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === "string"))].slice(0, 32);
  const agentCommands = new Map();
  if (typeof readConversation === "function") {
    await Promise.all(ids.slice(0, MAX_SESSIONS).map(async (id) => {
      try {
        const conversation = await readConversation(id);
        warned.delete(id);
        if (conversation) agentCommands.set(id, agentShellCommands(conversation));
      } catch (cause) {
        // The pane polls every few seconds: a failure is logged once until it changes.
        const message = String(cause?.message || cause).slice(0, 200);
        if (warned.get(id) !== message) {
          if (warned.size >= 64) warned.clear();
          warned.set(id, message);
          logger?.warn?.("ao.chat_agent_commands_unavailable", { session: id.slice(0, 128), message });
        }
      }
    }));
  }
  const bySession = new Map(listed.map((session) => [session?.sessionId, session]));
  const out = [];
  for (const id of ids) {
    const session = bySession.get(id);
    const agent = agentCommands.get(id) ?? [];
    if (!session && !agent.length) continue;
    const app = (Array.isArray(session?.commands) ? session.commands : []).map((command) => ({ ...command, source: "app" }));
    const commands = [...app, ...agent].sort((left, right) => (Number(right.startedAt) || 0) - (Number(left.startedAt) || 0));
    out.push({ ...(session ?? { sessionId: id, agent: null }), commands });
  }
  // A session the app listed that was not asked about by id stays as it was.
  for (const session of listed) if (!ids.includes(session?.sessionId)) out.push(session);
  return out;
}

module.exports = { agentShellCommands, withAgentShellCommands, utf8Suffix, CONVERSATION_LIMITS, MAX_OUTPUT_BYTES };
