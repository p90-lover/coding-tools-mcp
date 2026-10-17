"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");
const { agentShellCommands, withAgentShellCommands, utf8Suffix, MAX_OUTPUT_BYTES } = require("../electron/chat-agent-shell.cjs");

const BIG = `${"x".repeat(40_000)}\nlast line`;

// What AO's conversation endpoint returns for a chat whose agent ran its own Bash: one call still
// running (ACP execute, streamed terminal output folded into detail.output) and one finished.
function conversation() {
  return {
    messages: [{ id: "m1", sequence: 1, role: "assistant", text: "Running the tests." }],
    activities: [
      { id: "a-done", sequence: 2, activityKind: "command", status: "completed", createdAt: "2026-10-16T10:00:00.000Z",
        summary: "npm test", detail: { protocol: "acp", toolKind: "execute", command: "npm test", rawCommand: "bash -lc 'npm test'",
          input: { command: "npm test", description: "Run the tests" }, output: BIG, exitCode: 0, terminalId: "t1" } },
      { id: "a-run", sequence: 5, activityKind: "command", status: "running", createdAt: "2026-10-16T10:01:00.000Z",
        detail: { protocol: "acp", toolKind: "execute", command: "npm run dev", output: "ready on :5173\n" } },
      // Older ACP builds: the agent's own shell tool as an mcp_tool with input.command, its result fenced.
      { id: "a-old", sequence: 3, activityKind: "mcp_tool", status: "failed", createdAt: "2026-10-16T09:59:00.000Z",
        summary: "Bash", detail: { toolName: "Bash", input: { command: "ls missing" },
          content: [{ type: "content", content: { type: "text", text: "```console\nls: missing: No such file\n```" } }] } },
      // The app's own exec_command (an MCP server tool) is listed by the app already, not again.
      { id: "a-app", sequence: 4, activityKind: "mcp_tool", status: "completed", summary: "mcp__coding-tools__exec_command",
        detail: { toolName: "mcp__coding-tools__exec_command", input: { command: "echo hi" } } },
      { id: "a-read", sequence: 6, activityKind: "mcp_tool", status: "completed", detail: { toolKind: "read", input: { path: "a.txt" } } },
      { id: "a-think", sequence: 7, activityKind: "reasoning", status: "completed", detail: { text: "hmm" } },
    ],
  };
}

test("agent shell commands are read from AO activities, newest first, with a capped output tail", () => {
  const entries = agentShellCommands(conversation());
  assert.deepEqual(entries.map((entry) => entry.id), ["agent:a-run", "agent:a-old", "agent:a-done"]);
  const [running, failed, done] = entries;
  assert.equal(running.source, "agent");
  assert.equal(running.running, true);
  assert.equal(running.status, "running");
  assert.equal(running.command, "npm run dev");
  assert.equal(running.cmd, "npm run dev");
  assert.equal(running.output, "ready on :5173\n");
  assert.equal(running.startedAt, Date.parse("2026-10-16T10:01:00.000Z"));
  assert.equal(running.exitCode, null);
  assert.equal(failed.running, false);
  assert.equal(failed.status, "failed");
  assert.equal(failed.output, "ls: missing: No such file", "the Markdown fence is taken off");
  assert.equal(done.running, false);
  assert.equal(done.exitCode, 0);
  assert.equal(done.command, "npm test", "the display form, not the shell wrapper");
  assert.ok(Buffer.byteLength(done.output) <= MAX_OUTPUT_BYTES);
  assert.ok(done.output.endsWith("last line"), "the tail is kept");
  for (const entry of entries) assert.equal("sequence" in entry, false);
});

test("the listing is bounded and long commands are truncated", () => {
  const activities = Array.from({ length: 70 }, (_, index) => ({ id: `c${index}`, sequence: index, activityKind: "command", status: "completed",
    detail: { command: index === 69 ? `echo ${"y".repeat(5000)}` : `echo ${index}` } }));
  const entries = agentShellCommands({ activities });
  assert.equal(entries.length, 40);
  assert.equal(entries[0].id, "agent:c69");
  assert.ok(Buffer.byteLength(entries[0].command) <= 1000);
  assert.deepEqual(agentShellCommands(null), []);
  assert.deepEqual(agentShellCommands({ activities: [null, { activityKind: "command" }, { id: 1, activityKind: "command", detail: {} }] }), []);
});

test("utf8Suffix keeps the newest bytes and never splits a character", () => {
  assert.equal(utf8Suffix("short", 100), "short");
  const text = `${"é".repeat(100)}😀end`;
  const tail = utf8Suffix(text, 11);
  assert.ok(Buffer.byteLength(tail) <= 11);
  assert.ok(text.endsWith(tail));
  assert.equal(tail, "éé😀end");
  // Cutting inside the emoji drops it whole rather than leaving half a surrogate pair.
  assert.equal(utf8Suffix("a😀end", 5), "end");
});

test("app commands are marked source app and merged with the agent's own commands", async () => {
  const requests = [];
  // A fake of the upstream's internalApi: the conversation endpoint per session.
  const internalApi = async (method, endpoint) => {
    requests.push(`${method} ${endpoint}`);
    if (endpoint === "/api/v1/sessions/s1/conversation?limit=60") return conversation();
    throw new Error("session not found");
  };
  const readConversation = (id) => internalApi("GET", `/api/v1/sessions/${id}/conversation?limit=60`);
  const warnings = [];
  const logger = { warn: (event, data) => warnings.push({ event, data }) };
  const app = [{ sessionId: "s1", agent: "claude", commands: [
    { id: "x1", cmd: "npm run build", workdir: ".", startedAt: Date.parse("2026-10-16T10:00:30.000Z"), status: "running", exitCode: null, user: false },
  ] }];
  const sessions = await withAgentShellCommands(app, ["s1", "s2"], readConversation, logger);
  assert.equal(sessions.length, 1, "a session with nothing to show is left out");
  assert.equal(sessions[0].sessionId, "s1");
  assert.equal(sessions[0].agent, "claude");
  assert.deepEqual(sessions[0].commands.map((command) => `${command.source}:${command.id}`),
    ["agent:agent:a-run", "app:x1", "agent:agent:a-done", "agent:agent:a-old"]);
  const appCommand = sessions[0].commands.find((command) => command.id === "x1");
  assert.deepEqual(appCommand, { ...app[0].commands[0], source: "app" });
  assert.equal(warnings.length, 1, "the failed read is logged");
  assert.equal(warnings[0].event, "ao.chat_agent_commands_unavailable");
  assert.equal(warnings[0].data.session, "s2");
  // The same failure on the next poll is not logged again.
  await withAgentShellCommands(app, ["s1", "s2"], readConversation, logger);
  assert.equal(warnings.length, 1);
  assert.deepEqual(requests.filter((request) => request.includes("/s1/")).length, 2);
});

test("a session the app does not list still shows the agent's commands; failures keep the app listing", async () => {
  const onlyAgent = await withAgentShellCommands([], ["s1"], async () => conversation(), { warn() {} });
  assert.equal(onlyAgent.length, 1);
  assert.equal(onlyAgent[0].sessionId, "s1");
  assert.ok(onlyAgent[0].commands.every((command) => command.source === "agent"));

  const app = [{ sessionId: "s1", agent: "codex", commands: [{ id: "x1", cmd: "ls", workdir: ".", startedAt: 1, status: "exited", exitCode: 0 }] }];
  const failed = await withAgentShellCommands(app, ["s1"], async () => { throw new Error("AO response exceeds the handler limit"); }, { warn() {} });
  assert.deepEqual(failed, [{ ...app[0], commands: [{ ...app[0].commands[0], source: "app" }] }]);
  const broken = await withAgentShellCommands(app, ["s1"], async () => ({ activities: "nonsense" }), null);
  assert.deepEqual(broken[0].commands.map((command) => command.id), ["x1"]);
  const noReader = await withAgentShellCommands(app, ["s1"], null);
  assert.deepEqual(noReader[0].commands.map((command) => command.source), ["app"]);
});

test("chat_processes lists the app's commands with AO stopped and without the agent tools", async () => {
  const { createAgentOrchestratorUpstream } = require("../electron/agent-orchestrator-upstream.cjs");
  const processes = async (ids) => [{ sessionId: ids[0], agent: "claude",
    commands: [{ id: "c1", cmd: "npm run dev", workdir: ".", startedAt: 5, status: "running", exitCode: null, user: false }] }];
  const make = (agentTools) => createAgentOrchestratorUpstream({ resourceRoot: os.tmpdir(), dataRoot: os.tmpdir(), agentTools, logger: { warn() {} } });
  const listed = await make({ processes }).call("chat_processes", { sessionIds: ["s1"] });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.sessions[0].commands.map((command) => [command.id, command.source]), [["c1", "app"]]);
  const none = await make(null).call("chat_processes", { sessionIds: ["s1"] });
  assert.deepEqual(none, { ok: true, sessions: [] });
});
