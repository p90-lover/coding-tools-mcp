"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
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

// Claude Code's Bash with run_in_background: the call completes at once with a notice naming the
// task and its output file; the dev server keeps running and writing to that file.
function backgroundConversation(file, extra = []) {
  return {
    activities: [
      { id: "bg", sequence: 10, activityKind: "command", status: "completed", createdAt: "2026-10-16T11:00:00.000Z",
        detail: { command: "npm run dev", input: { command: "npm run dev", run_in_background: true }, exitCode: 0,
          output: `Command running in background with ID: b7x2k9. Output is being written to: ${file}` } },
      { id: "ls", sequence: 11, activityKind: "command", status: "completed", createdAt: "2026-10-16T11:00:05.000Z",
        detail: { command: "ls", output: "src\n", exitCode: 0 } },
      ...extra,
    ],
  };
}

test("a backgrounded dev server is listed as running with the live tail of its output file", async () => {
  const fsp = require("node:fs/promises");
  const path = require("node:path");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "shell-bg-"));
  const file = path.join(dir, "claude-0", "-proj", "tasks", "b7x2k9.output");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, "VITE ready\n  Local: http://localhost:5173/\n");
  try {
    const [session] = await withAgentShellCommands([], ["bg1"], async () => backgroundConversation(file), { warn() {} });
    const server = session.commands.find((command) => command.id === "agent:bg");
    assert.equal(server.status, "background");
    assert.equal(server.running, true);
    assert.equal(server.background, true);
    assert.equal(server.exitCode, null);
    assert.equal(server.output, "VITE ready\n  Local: http://localhost:5173/\n");
    assert.equal("outputFile" in server, false, "the file's path is not handed to the renderer");
    assert.equal(session.commands.find((command) => command.id === "agent:ls").status, "completed");

    // Later polls: the launch scrolled out of AO's page, yet the server stays listed with new output.
    await fsp.appendFile(file, "page reload src/App.tsx\n");
    const later = await withAgentShellCommands([], ["bg1"], async () => ({ activities: [] }), { warn() {} });
    assert.equal(later[0].commands[0].id, "agent:bg");
    assert.ok(later[0].commands[0].output.endsWith("page reload src/App.tsx\n"));

    // TaskStop ends it.
    const stopped = await withAgentShellCommands([], ["bg1"], async () => ({ activities: [
      { id: "stop", sequence: 20, activityKind: "mcp_tool", status: "completed", detail: { toolName: "TaskStop", input: { task_id: "b7x2k9" } } },
    ] }), { warn() {} });
    assert.equal(stopped[0].commands[0].status, "killed");
    assert.equal(stopped[0].commands[0].running, false);
    // And the end stands once the TaskStop scrolls out while the launch is back in the page.
    const after = await withAgentShellCommands([], ["bg1"], async () => backgroundConversation(file), { warn() {} });
    assert.equal(after[0].commands.find((command) => command.id === "agent:bg").status, "killed");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a TaskOutput report settles a background command; a missing output file reads as gone", async () => {
  const file = "/tmp/claude-0/-proj/tasks/b7x2k9.output";
  const done = { id: "out", sequence: 12, activityKind: "mcp_tool", status: "completed",
    detail: { toolName: "TaskOutput", input: { task_id: "b7x2k9", block: false },
      output: "<retrieval_status>success</retrieval_status><task_id>b7x2k9</task_id><status>failed</status><exit_code>1</exit_code>" } };
  const [settled] = await withAgentShellCommands([], ["bg2"], async () => backgroundConversation(file, [done]), { warn() {} }, async () => "tail");
  const server = settled.commands.find((command) => command.id === "agent:bg");
  assert.equal(server.status, "failed");
  assert.equal(server.exitCode, 1);
  assert.equal(server.running, false);

  const [gone] = await withAgentShellCommands([], ["bg3"], async () => backgroundConversation(file), { warn() {} }, async () => null);
  assert.equal(gone.commands.find((command) => command.id === "agent:bg").status, "gone");
});

test("only Claude Code's own task output files are read", () => {
  const { backgroundOutputPath } = require("../electron/chat-agent-shell.cjs");
  assert.equal(backgroundOutputPath("/tmp/claude-1000/-home-me-app/tasks/b1.output", "b1"), path.resolve("/tmp/claude-1000/-home-me-app/tasks/b1.output"));
  assert.equal(backgroundOutputPath("/tmp/claude/-p/tasks/b1.output", "b1"), path.resolve("/tmp/claude/-p/tasks/b1.output"));
  assert.equal(backgroundOutputPath("/home/me/.ssh/id_rsa", "b1"), null);
  assert.equal(backgroundOutputPath("/tmp/claude/-p/tasks/b2.output", "b1"), null, "the file must be the announced task's");
  assert.equal(backgroundOutputPath("/tmp/other/tasks/b1.output", "b1"), null);
  assert.equal(backgroundOutputPath("relative/claude/tasks/b1.output", "b1"), null);
  assert.equal(backgroundOutputPath(undefined, "b1"), null);
});
