"use strict";

// The chat Terminal pane's view of the shell commands a chat agent ran with its own tool (Claude
// Code's Bash/PowerShell over ACP, Codex's shell), next to the ones it started through the app's
// exec_command. AO records each as a conversation activity: an ACP "execute" call and a Codex
// command are activityKind "command" with detail.command (and rawCommand), detail.output (streamed
// terminal output folded in by AO), detail.exitCode and, for Codex, detail.cwd; older ACP builds
// report the call as "mcp_tool" with input.command. Read-only: the app neither types into nor
// stops these, the agent's own process owns them.
//
// A dev server or app the agent starts with run_in_background (or one Claude Code backgrounds after
// its timeout) ends its tool call at once with a notice naming the task and the file Claude Code
// writes its output to. Such a command is listed as "background" with the live tail of that file,
// kept after it scrolls out of the conversation page AO returns, until a TaskOutput / BashOutput
// read reports it ended, TaskStop / KillShell stops it, or its output file is gone.

const fs = require("node:fs");
const path = require("node:path");

const MAX_AGENT_COMMANDS = 40;
const MAX_COMMAND_BYTES = 1000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_SESSIONS = 8;
// What AO reads back per poll: the newest items of the conversation (messages and activities).
const CONVERSATION_LIMITS = [60, 20];
// Background commands remembered per session past the conversation page, and sessions remembered.
const MAX_BACKGROUND_COMMANDS = 10;
const MAX_REMEMBERED_SESSIONS = 64;

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

// Claude Code's notice for a backgrounded command: its task id and, in current versions, the file
// its output goes to (<tmp>/claude[-uid]/<project>/tasks/<id>.output). The path may hold spaces.
const BACKGROUND_NOTICE = /(?:running in background|was manually backgrounded by user) with ID: ([A-Za-z0-9_-]{1,64})\.(?: Output is being written to: ([^\r\n]+?\.output))?[ \t]*$/m;
// The tools that read or stop a background task, and the input key naming it.
const TASK_READERS = new Set(["TaskOutput", "BashOutput"]);
const TASK_STOPPERS = new Set(["TaskStop", "KillShell", "KillBash"]);
const taskIdOf = (input) => [input.task_id, input.bash_id, input.shell_id].find((value) => typeof value === "string" && value) ?? null;

/**
 * The file a background command's notice names, when it is where Claude Code keeps task output:
 * an absolute `.../tasks/<id>.output` under a `claude` or `claude-<uid>` folder. Anything else
 * (an agent echoing a lookalike notice) is not read.
 */
function backgroundOutputPath(raw, taskId) {
  if (typeof raw !== "string" || !path.isAbsolute(raw.trim())) return null;
  const resolved = path.resolve(raw.trim());
  if (path.basename(resolved) !== `${taskId}.output` || path.basename(path.dirname(resolved)) !== "tasks") return null;
  return resolved.split(/[\\/]/).some((part) => /^claude(?:-[\w.-]+)?$/i.test(part)) ? resolved : null;
}

/**
 * The agent's own shell commands in an AO conversation, newest first, as Terminal pane entries,
 * and what the conversation says became of each background task (task id -> status, exit code).
 */
function readAgentShell(conversation, limit = MAX_AGENT_COMMANDS) {
  const activities = Array.isArray(conversation?.activities) ? conversation.activities : [];
  const entries = [];
  const tasks = new Map(); // task id -> { status, exitCode, sequence }
  for (const activity of activities) {
    if (!activity || typeof activity !== "object" || activity.id === undefined || activity.id === null) continue;
    const detail = activity.detail && typeof activity.detail === "object" ? activity.detail : {};
    const input = detail.input && typeof detail.input === "object" ? detail.input : {};
    const sequence = Number(activity.sequence) || 0;
    const toolName = String(detail.toolName || detail.providerToolName || activity.summary || "");
    const taskId = taskIdOf(input);
    if (taskId && (TASK_READERS.has(toolName) || TASK_STOPPERS.has(toolName)) && activity.status === "completed") {
      let state = null;
      if (TASK_STOPPERS.has(toolName)) state = { status: "killed", exitCode: null };
      else {
        const text = outputText(detail);
        const status = /<status>([a-z_]{1,32})<\/status>/.exec(text)?.[1];
        const exit = /<exit_code>(-?\d{1,10})<\/exit_code>/.exec(text)?.[1];
        if (status && !RUNNING.has(status)) state = { status, exitCode: exit === undefined ? null : Number(exit) };
      }
      if (state && (tasks.get(taskId)?.sequence ?? -1) < sequence) tasks.set(taskId, { ...state, sequence });
      continue;
    }
    const command = commandText(activity, detail, input);
    if (!command) continue;
    const status = String(activity.status || "").slice(0, 32);
    let running = RUNNING.has(status);
    let exitCode = Number.isInteger(detail.exitCode) ? detail.exitCode : null;
    const startedAt = Date.parse(activity.createdAt ?? "") || Date.parse(activity.updatedAt ?? "") || 0;
    const cmd = utf8Prefix(command, MAX_COMMAND_BYTES);
    const output = outputText(detail);
    const notice = status === "completed" ? BACKGROUND_NOTICE.exec(output) : null;
    const entry = {
      id: `agent:${String(activity.id).slice(0, 200)}`, cmd, command: cmd,
      workdir: typeof detail.cwd === "string" ? detail.cwd.slice(0, 1024) : "",
      startedAt, status: running ? "running" : status || "completed", running, exitCode,
      output, source: "agent", sequence,
    };
    if (notice) {
      // The call ended; the command did not. It runs on until the conversation says otherwise.
      running = true;
      exitCode = null;
      Object.assign(entry, { status: "background", running, exitCode, taskId: notice[1], outputFile: backgroundOutputPath(notice[2], notice[1]) });
    }
    entries.push(entry);
  }
  const listed = entries
    .sort((left, right) => right.sequence - left.sequence || right.startedAt - left.startedAt)
    .slice(0, limit)
    .map(({ sequence: _sequence, ...entry }) => entry);
  for (const entry of listed) settle(entry, tasks);
  return { entries: listed, tasks };
}

/** A background entry the conversation reports ended takes that status. */
function settle(entry, tasks) {
  const ended = entry.taskId ? tasks.get(entry.taskId) : null;
  if (!ended || entry.status !== "background") return;
  Object.assign(entry, { status: ended.status, running: false, exitCode: ended.exitCode });
}

/** The agent's own shell commands in an AO conversation, newest first, as Terminal pane entries. */
function agentShellCommands(conversation, limit = MAX_AGENT_COMMANDS) {
  return readAgentShell(conversation, limit).entries.map(({ outputFile: _file, taskId: _task, ...entry }) => entry);
}

/** The newest `maxBytes` of a file as UTF-8 text (a split leading character is dropped), or null when it is gone. */
async function fileTail(file, maxBytes = MAX_OUTPUT_BYTES) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFFFD+/, "");
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Session -> (entry id -> background entry), so a dev server started long ago stays listed.
const remembered = new Map();

/**
 * One session's agent shell entries with its background commands: those in this page, those
 * remembered from earlier pages (settled by what this page says of them), each live one with the
 * tail of its output file. The listing never carries the file's path.
 */
async function withBackground(sessionId, conversation, readTail) {
  const { entries, tasks } = readAgentShell(conversation);
  let known = remembered.get(sessionId);
  if (!known) {
    known = new Map();
    remembered.set(sessionId, known);
    while (remembered.size > MAX_REMEMBERED_SESSIONS) remembered.delete(remembered.keys().next().value);
  }
  for (const entry of entries) {
    if (!entry.taskId) continue;
    // An end reported on an earlier page stands after that report scrolls out of this one.
    const prior = known.get(entry.id);
    if (prior && prior.status !== "background" && entry.status === "background") {
      Object.assign(entry, { status: prior.status, running: prior.running, exitCode: prior.exitCode });
    }
    known.set(entry.id, entry);
  }
  for (const entry of known.values()) settle(entry, tasks);
  while (known.size > MAX_BACKGROUND_COMMANDS) {
    const [oldest] = [...known.values()].sort((left, right) => Number(left.running) - Number(right.running) || left.startedAt - right.startedAt);
    known.delete(oldest.id);
  }
  const listed = new Set(entries.map((entry) => entry.id));
  const all = [...entries, ...[...known.values()].filter((entry) => !listed.has(entry.id))];
  await Promise.all(all.map(async (entry) => {
    if (entry.status !== "background" || !entry.outputFile) return;
    try {
      const tail = await readTail(entry.outputFile);
      if (tail === null) Object.assign(entry, { status: "gone", running: false });
      else entry.output = tail;
    } catch { /* unreadable this poll: the last tail stands */ }
  }));
  return all.map(({ outputFile: _file, taskId: _task, ...entry }) => ({ ...entry, ...(entry.status === "background" ? { background: true } : {}) }));
}

/**
 * The Terminal pane's listing: each session's app commands (from chat-agent-tools processes(),
 * marked source "app") with the agent's own shell commands read from its AO conversation. A
 * conversation that cannot be read is logged and left out; the app's listing always stands.
 */
async function withAgentShellCommands(appSessions, sessionIds, readConversation, logger = console, readTail = fileTail) {
  const listed = Array.isArray(appSessions) ? appSessions : [];
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === "string"))].slice(0, 32);
  const agentCommands = new Map();
  if (typeof readConversation === "function") {
    await Promise.all(ids.slice(0, MAX_SESSIONS).map(async (id) => {
      try {
        const conversation = await readConversation(id);
        warned.delete(id);
        if (conversation) agentCommands.set(id, await withBackground(id, conversation, readTail));
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

module.exports = { agentShellCommands, withAgentShellCommands, backgroundOutputPath, utf8Suffix, CONVERSATION_LIMITS, MAX_OUTPUT_BYTES };
