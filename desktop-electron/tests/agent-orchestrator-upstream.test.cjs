"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const test = require("node:test");
const { createAgentOrchestratorGateway } = require("../electron/agent-orchestrator-gateway.cjs");
const handler = require("../../app-handler/agent-orchestrator/handler.cjs");
const { invokeContract } = require("../electron/ipc-schema.cjs");
const { createCodingToolsAppsHost } = require("../../app-handler/host.cjs");

test("upstream AO gateway runs trusted UI requests automatically and blocks untrusted or remote access", async () => {
  const fixtureRoot = path.resolve(__dirname, "../../aiTemp/ao-gateway-tests");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "index.html"), "<h1>Original renderer fixture</h1>");
  const received = [];
  const daemon = http.createServer((request, response) => {
    received.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ projects: [] }));
  });
  await new Promise((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const gateway = createAgentOrchestratorGateway({
    rendererRoot: fixtureRoot, daemonPort: daemon.address().port,
    getStatus: () => ({ state: "ready" }), desktopRequest: async () => "version",
  });
  try {
    const { origin, openUrl } = await gateway.listen();
    assert.equal((await fetch(`${origin}/api/v1/projects`)).status, 403);
    const bootstrap = await fetch(openUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(openUrl, { redirect: "manual" })).status, 403);
    assert.equal((await fetch(origin, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/projects`, { headers: { cookie, origin: "https://hostile.example" } })).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/mobile/enable`, { method: "POST", headers: { cookie, origin } })).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/projects`, { headers: { cookie, origin } })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/agents/readiness/ensure`, {
      method: "POST", headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [], purpose: "display" }),
    })).status, 200);
    assert.equal((await fetch(`${origin}/api/v1/sessions`, { method: "POST", headers: { cookie, origin } })).status, 200);
    assert.deepEqual(received, ["/api/v1/projects", "/api/v1/agents/readiness/ensure", "/api/v1/sessions"]);
  } finally {
    await gateway.close();
    await new Promise((resolve) => daemon.close(resolve));
  }
});


/** The real observe() with its helpers, run against a fake AO API. */
function observeHarness(context) {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async observe(id");
  const end = source.indexOf("    async interrupt(id)", start);
  const method = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  return vm.runInNewContext(states + helpers + identity + "({" + method + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"),
    observeTui: async () => { throw new Error("not a TUI fixture"); }, ...context,
  });
}

test("actual upstream observe exposes bounded current streaming output separately from terminal evidence", async () => {
  let turn = "owned-turn";
  const messages = [
    { role: "assistant", turnId: "other-turn", streaming: true, text: "OTHER_TURN_SECRET" },
    { role: "user", turnId: turn, text: "user message is not output" },
    { role: "assistant", turnId: turn, streaming: false, text: "verified part" },
    { role: "assistant", turnId: turn, streaming: true, text: "streaming partial " + "界".repeat(5000) },
  ];
  const upstream = observeHarness({
    internalApi: async (method, endpoint) => {
      assert.equal(method, "GET");
      if (endpoint === "/api/v1/sessions/owned-session") return { session: { id: "owned-session", mode: "chat", status: "working" } };
      if (endpoint === "/api/v1/sessions/owned-session/conversation?limit=100") return { turns: [{ id: turn, state: "running" }], messages };
      throw new Error("Session is not owned");
    },
  });
  const observed = await upstream.observe("owned-session");
  assert.equal(observed.answer, "verified part", "streaming must not become terminal answer evidence");
  assert.match(observed.liveOutput, /streaming partial/);
  assert.ok(Buffer.byteLength(observed.liveOutput, "utf8") <= 4096);
  assert.doesNotMatch(observed.liveOutput, /OTHER_TURN_SECRET|user message/);
  turn = "new-turn";
  const current = await upstream.observe("owned-session");
  assert.equal(current.liveOutput, "", "old turn output is not current output");
  await assert.rejects(upstream.observe("bad/session"), /valid AO session ID/);
});

test("observe returns the current turn's reasoning, tool calls and messages in order", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100") ? {
      turns: [{ id: "t", state: "running" }],
      messages: [
        { id: "m0", role: "user", turnId: "t", sequence: 1, text: "the prompt" },
        { id: "m1", role: "assistant", turnId: "t", sequence: 4, text: "Checking the files", streaming: true },
        { id: "old", role: "assistant", turnId: "earlier", sequence: 0, text: "previous turn" },
      ],
      activities: [
        { id: "a2", turnId: "t", sequence: 3, activityKind: "command", status: "running", summary: "git status" },
        { id: "a1", turnId: "t", sequence: 2, activityKind: "reasoning", status: "completed", summary: "Reasoning" },
      ],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const observed = await upstream.observe("s");
  assert.deepEqual(JSON.parse(JSON.stringify(observed.timeline)), [
    { id: "a1", sequence: 2, kind: "reasoning", status: "completed", text: "" },
    { id: "a2", sequence: 3, kind: "command", status: "running", text: "git status" },
    { id: "m1", sequence: 4, kind: "message", status: "running", text: "Checking the files" },
  ], "the prompt and earlier turns are left out");
});

test("a running turn whose chat host is gone is interrupted, even when its PID was reused", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ao-host-"));
  const closed = await new Promise(resolve => { const probe = require("node:net").createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const live = require("node:net").createServer().listen(0, "127.0.0.1");
  await new Promise(resolve => live.once("listening", resolve));
  const hostFile = path.join(dataRoot, "chat-hosts", "s", "host.json");
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  const calls = [];
  let turnState = "running";
  const upstream = observeHarness({ dataRoot,
    internalApi: async (method, endpoint) => {
      calls.push(`${method} ${endpoint}`);
      if (endpoint.endsWith("/conversation?limit=100")) return { turns: [{ id: "t", state: turnState }], messages: [] };
      if (endpoint.endsWith("/interrupt")) return {};
      return { session: { id: "s", mode: "chat", status: "working" } };
    },
  });
  try {
    // The PID now belongs to this test process, as a reused PID would; only the address counts.
    fs.writeFileSync(hostFile, JSON.stringify({ pid: process.pid, address: `127.0.0.1:${live.address().port}` }));
    assert.equal((await upstream.observe("s")).turnState, "running", "a listening host is alive");
    fs.writeFileSync(hostFile, JSON.stringify({ pid: process.pid, address: `127.0.0.1:${closed}` }));
    const orphan = await upstream.observe("s");
    assert.equal(orphan.turnState, "interrupted");
    assert.match(orphan.error, /retry this card/);
    assert.ok(calls.includes("POST /api/v1/sessions/s/conversation/interrupt"), "AO settles the turn through its own interrupt");
    // A later read sees the settled turn; it still names the restart and does not interrupt again.
    turnState = "interrupted"; calls.length = 0;
    assert.match((await upstream.observe("s")).error, /the app restarted/);
    assert.ok(!calls.some(call => call.endsWith("/interrupt")));
    // A turn the user stopped keeps its live host: a plain interruption.
    fs.writeFileSync(hostFile, JSON.stringify({ pid: process.pid, address: `127.0.0.1:${live.address().port}` }));
    assert.equal((await upstream.observe("s")).error, undefined);
  } finally {
    live.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("every operation the renderer calls is one the AO module accepts (the chat's commands included)", () => {
  const features = path.resolve(__dirname, "../src/features");
  const called = new Set();
  for (const file of fs.readdirSync(features).filter(name => /\.tsx?$/.test(name))) {
    for (const match of fs.readFileSync(path.join(features, file), "utf8").matchAll(/moduleCall\("([a-z_]+)"/g)) called.add(match[1]);
  }
  for (const operation of ["chat_send", "chat_goal", "compact_chat", "chat_diff", "chat_delete_message", "runs"]) assert.ok(called.has(operation), `${operation} is called`);
  const unknown = [...called].filter(operation => !handler.operations.includes(operation));
  assert.deepEqual(unknown, [], "an operation missing here fails in the app as \"Unknown Agent Orchestrator operation\"");
  assert.equal(handler.isReadOnly("chat_diff"), true);
  assert.equal(handler.isReadOnly("chat_goal"), false);
  assert.equal(handler.isReadOnly("compact_chat"), false);
  assert.equal(handler.isReadOnly("chat_delete_message"), false);
});

test("AO handler exposes named upstream APIs and keeps absent board detail JSON-safe", async () => {
  assert.equal(handler.isReadOnly("upstream_projects"), true);
  assert.equal(handler.isReadOnly("upstream_create_session"), false);
  assert.equal(handler.isReadOnly("upstream_show"), false);
  const operations = [];
  const host = createCodingToolsAppsHost({ services: {
    agentOrchestrator: async () => ({ ok: true, tasks: [] }),
    agentOrchestratorUpstream: async (operation, args) => { operations.push([operation, args]); return { ok: true, data: [] }; },
  } });
  const ipc = { invoke: (_channel, input) => host.call(input.moduleId, input.operation, input.arguments) };
  const result = await invokeContract(ipc, "apps.call", { moduleId: "agent-orchestrator", operation: "board", arguments: {} });
  assert.equal(result.result.task, null);
  await host.call("agent-orchestrator", "upstream_projects", {});
  assert.deepEqual(operations, [["upstream_projects", {}]]);
  // The approval card's read of a workspace's dependency links is served by the AO runtime.
  assert.equal(handler.isReadOnly("dependency_link_info"), true);
  await host.call("agent-orchestrator", "dependency_link_info", { workspaceId: "ws" });
  assert.deepEqual(operations.at(-1), ["dependency_link_info", { workspaceId: "ws" }]);
  await assert.rejects(host.call("agent-orchestrator", "upstream_arbitrary_url", { url: "http://example.com" }), /does not expose/);
});

test("closing the AO gateway cancels a backend request stalled before response headers", async () => {
  let markReceived;
  let markClosed;
  const received = new Promise((resolve) => { markReceived = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const daemon = http.createServer((_request, response) => {
    response.once("close", markClosed);
    markReceived();
  });
  await new Promise((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const gateway = createAgentOrchestratorGateway({ rendererRoot: __dirname, daemonPort: daemon.address().port, getStatus: () => ({}), desktopRequest: async () => null });
  try {
    const { origin, openUrl } = await gateway.listen();
    const bootstrap = await fetch(openUrl, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    const pending = fetch(`${origin}/api/v1/projects`, { headers: { cookie }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    await received;
    await gateway.close();
    await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Backend socket remained open")), 1000).unref())]);
    await pending;
  } finally {
    await gateway.close();
    daemon.closeAllConnections();
    await new Promise((resolve) => daemon.close(resolve));
  }
});

test("an AO harness is offered on evidence only: proven, installed last time or being confirmed; an unfinished check is marked checking", () => {
  const { agentCatalog } = require("../electron/agent-orchestrator-upstream.cjs");
  const supported = ["claude-code", "codex", "aider", "goose", "amp", "kiro"].map(id => ({ id, label: id }));
  const inventory = { supported, installed: [{ id: "codex", authStatus: "authorized" }] };
  // Reason codes as a busy machine's AO reported them right after a start.
  const readiness = { agents: [
    { id: "claude-code", installation: { state: "unknown", reasonCode: "checking" } },
    { id: "aider", installation: { state: "not_installed", reasonCode: "not_installed" } },
    { id: "goose", installation: { state: "unknown", reasonCode: "install_check_unsupported" } },
    { id: "amp", installation: { state: "unknown", reasonCode: "install_check_timeout" } },
    { id: "kiro", installation: { state: "unknown", reasonCode: "install_identity_pending" } },
  ] };
  const offered = list => Object.fromEntries(list.map(item => [item.id, item.installed]));
  // A timed-out check proves nothing (most agents time out on a busy machine): not offered. A binary
  // AO found and is confirming is offered; a check still running is not yet, but asks for another read.
  const first = agentCatalog({ inventory, readiness });
  assert.deepEqual(offered(first), { "claude-code": false, codex: true, aider: false, goose: false, amp: false, kiro: true });
  assert.deepEqual(first.filter(item => item.checking).map(item => item.id), ["claude-code"]);
  // Installed last time and the readiness read failed: still offered, with its last auth status.
  const kept = agentCatalog({ inventory, readiness: null, lastInstalled: new Map([["claude-code", "authorized"]]) });
  assert.deepEqual(kept.find(item => item.id === "claude-code"), { id: "claude-code", label: "claude-code", installed: true, authStatus: "authorized", chat: false });
  // AO saying it is not installed wins over the memory.
  const gone = { agents: [{ id: "claude-code", installation: { state: "not_installed", reasonCode: "not_installed" } }] };
  assert.equal(agentCatalog({ inventory, readiness: gone, lastInstalled: new Map([["claude-code", "authorized"]]) })[0].installed, false);
});

test("the AO harness list waits for fresh install checks and re-checks after a minute", async () => {
  const { createAgentInventory } = require("../electron/agent-orchestrator-upstream.cjs");
  let clock = 0;
  const calls = [];
  const fresh = { supported: [{ id: "codex" }, { id: "opencode" }], installed: [{ id: "codex" }, { id: "opencode" }] };
  const partial = { supported: fresh.supported, installed: [{ id: "codex" }] };
  const api = async (method, endpoint) => { calls.push(`${method} ${endpoint}`); return method === "POST" ? fresh : partial; };
  const inventory = createAgentInventory(api, { now: () => clock, recheckMs: 60_000 });
  assert.deepEqual(await inventory(), fresh, "the first list runs the checks instead of reading half-finished ones");
  clock = 30_000;
  assert.deepEqual(await inventory(), partial, "within a minute the cached list is read");
  clock = 61_000;
  await inventory();
  assert.deepEqual(calls, ["POST /api/v1/agents/refresh", "GET /api/v1/agents", "POST /api/v1/agents/refresh"]);

  const older = createAgentInventory(async (method) => { if (method === "POST") throw new Error("404"); return partial; });
  assert.deepEqual(await older(), partial, "a daemon without refresh still answers the plain list");
});

test("observe lists the agent's parked tool requests with AO's offered decisions, and resolveApproval answers one", async () => {
  const calls = [];
  const upstream = observeHarness({
    internalApi: async (method, endpoint, body) => {
      calls.push([method, endpoint, body]);
      if (endpoint.endsWith("/conversation?limit=100")) return {
        turns: [{ id: "t", state: "running" }], messages: [],
        activities: [
          { id: "a1", turnId: "t", sequence: 2, activityKind: "approval", status: "pending", requestId: "req-1", summary: "Bash",
            detail: { toolKind: "execute", toolName: "Bash", input: { command: "npm test", description: "Run the tests" },
              decisions: [{ id: "allow", kind: "allow_once", label: "Allow" }, { id: "always", kind: "allow_always", label: "Always" }, { id: "no", kind: "reject_once", label: "Reject" }] } },
          { id: "a2", turnId: "t", sequence: 3, activityKind: "approval", status: "resolved", requestId: "req-0", detail: { decisions: [{ id: "x", kind: "allow_once" }] } },
          { id: "a3", turnId: "t", sequence: 4, activityKind: "approval", status: "pending", requestId: "req-2", summary: "Edit app.ts",
            detail: { toolKind: "edit", toolName: "Edit", input: { file_path: "src/app.ts" }, decisions: [{ id: "ok", kind: "allow_once" }] } },
        ],
      };
      return endpoint.includes("/resolve") ? undefined : { session: { id: "s", mode: "chat", status: "working" } };
    },
  });
  const observed = await upstream.observe("s");
  const approvals = JSON.parse(JSON.stringify(observed.approvals));
  assert.deepEqual(approvals.map(item => [item.approval_id, item.kind, item.tool, item.command ?? item.path]),
    [["req-1", "command", "Bash", "npm test"], ["req-2", "permission", "Edit", "src/app.ts"]], "only pending requests; Bash is a command");
  assert.equal(approvals[0].reason, "Run the tests");
  assert.deepEqual(approvals[0].decisions.map(decision => decision.kind), ["allow_once", "allow_always", "reject_once"]);
  await upstream.resolveApproval("s", "req-1", "allow");
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["POST", "/api/v1/sessions/s/conversation/approvals/req-1/resolve", { decisionId: "allow" }]);
  await assert.rejects(upstream.resolveApproval("s", "req-1", ""), /offered decision/);
});

test("a follow-up turn is observed only once AO shows it; send and steer use AO's conversation routes", async () => {
  const calls = [];
  let turns = [{ id: "old", state: "completed" }];
  let steerError = null;
  const upstream = observeHarness({
    internalApi: async (method, endpoint, body) => {
      calls.push([method, endpoint, body]);
      if (endpoint.endsWith("/conversation?limit=100")) return { turns,
        messages: [{ id: "m", role: "assistant", turnId: "old", sequence: 1, text: "the previous answer" }], activities: [] };
      if (endpoint.endsWith("/conversation/messages")) return { turnId: "new", state: "running" };
      if (endpoint.endsWith("/conversation/steer")) { if (steerError) throw steerError; return { providerTurnId: "new" }; }
      return { session: { id: "s", mode: "chat", status: "working" } };
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await upstream.send("s", "and now the tests", "key-1"))), { turnId: "new", state: "running" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["POST", "/api/v1/sessions/s/conversation/messages", { text: "and now the tests", clientMessageId: "key-1" }]);
  const early = await upstream.observe("s", "new");
  assert.equal(early.turnState, "queued", "the completed previous turn is not this follow-up's answer");
  assert.equal(early.answer, "");
  turns = [...turns, { id: "new", state: "running" }];
  assert.equal((await upstream.observe("s", "new")).turnState, "running");
  assert.equal((await upstream.observe("s")).turnId, "new", "without a pin the latest turn is read");
  assert.deepEqual(JSON.parse(JSON.stringify(await upstream.steer("s", "use pnpm", "k2"))), { steered: true, turnId: "new" });
  steerError = new Error("there is no turn in flight to interrupt (CHAT_NO_ACTIVE_TURN)");
  assert.deepEqual(JSON.parse(JSON.stringify(await upstream.steer("s", "too late", "k3"))), { steered: false });
  steerError = new Error("AO is down");
  await assert.rejects(upstream.steer("s", "x", "k4"), /AO is down/, "other failures are not mistaken for an ended turn");
});

test("a steered message reads as the user's own words in the live timeline", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "s1", turnId: "t", sequence: 3, activityKind: "system", status: "completed", summary: "use pnpm…",
        detail: { event: "steer", text: "use pnpm, not npm" } },
        { id: "c1", turnId: "t", sequence: 2, activityKind: "system", status: "completed", summary: "Context compacted", detail: { event: "compaction" } }],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const timeline = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.deepEqual(timeline.map(item => [item.kind, item.text]), [["system", "Context compacted"], ["steer", "use pnpm, not npm"]]);
});

test("an idle agent is found by its last turn, released with exit-agent, and resumed when its chat continues", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  const now = Date.parse("2026-10-12T10:00:00Z");
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const sessions = [
    { id: "old", mode: "chat", status: "idle" },
    { id: "recent", mode: "chat", status: "idle" },
    { id: "typed", mode: "chat", status: "idle", lastUserMessageAt: ago(5) },
    { id: "warm", mode: "chat", status: "idle" },
    { id: "busy", mode: "chat", status: "working" },
    { id: "tui", mode: "tui", status: "idle" },
    { id: "gone", mode: "chat", status: "idle", isTerminated: true },
  ];
  const turns = { old: [{ state: "completed", completedAt: ago(90) }], recent: [{ state: "completed", completedAt: ago(10) }],
    typed: [{ state: "completed", completedAt: ago(90) }], warm: [] };
  const calls = [];
  let resumeOk = true;
  let status = "exited";
  const upstream = vm.runInNewContext(states + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), Date, Math, Number, Promise,
    internalApi: async (method, endpoint) => {
      calls.push([method, endpoint]);
      if (endpoint === "/api/v1/sessions") return { sessions };
      const id = endpoint.split("/")[4];
      if (endpoint.endsWith("/conversation?limit=1")) return { turns: turns[id] ?? [] };
      if (endpoint.endsWith("/exit-agent")) return { ok: true };
      if (endpoint.endsWith("/resume-agent")) { if (!resumeOk) throw new Error("resume failed"); status = "idle"; return { ok: true }; }
      return { session: { id, mode: "chat", status } };
    },
  });
  assert.deepEqual([...await upstream.idleChatSessions(30 * 60_000, now)], ["old"],
    "only a chat agent idle past the limit; a recent turn or message, a never-used (pre-warmed), working, TUI or terminated session is kept");
  await upstream.exitAgent("old");
  assert.deepEqual(calls.at(-1), ["POST", "/api/v1/sessions/old/exit-agent"]);
  assert.equal(await upstream.continuable("old"), true, "a released agent is resumed for the next message");
  assert.ok(calls.some(([method, endpoint]) => method === "POST" && endpoint === "/api/v1/sessions/old/resume-agent"));
  status = "exited"; resumeOk = false;
  assert.equal(await upstream.continuable("old"), false, "a failed resume falls back to a fresh session");
});

test("a terminal agent AO lost the signal of settles as failed once idle past the limit, never while it may still report", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const fnStart = source.indexOf("  async function observeTui(");
  const fnEnd = source.indexOf("  function snapshot()", fnStart);
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const consts = ["TUI_RESULT_FILE", "TUI_SILENT_MS"].map(name => source.match(new RegExp(`const ${name} = .*;`))[0]).join("\n");
  let report = null;
  const observeTui = vm.runInNewContext(consts + identity + source.slice(fnStart, fnEnd) + "\nobserveTui", {
    Date, Number, String,
    internalApi: async () => { if (!report) throw new Error("no file"); return { content: report }; },
  });
  const now = Date.parse("2026-10-12T09:00:00Z");
  const idleSince = minutes => ({ state: "idle", lastActivityAt: new Date(now - minutes * 60_000).toISOString() });
  const stuck = await observeTui("reg-machine-7", "no_signal", idleSince(18 * 60), now);
  assert.equal(stuck.turnState, "failed");
  assert.equal(stuck.exited, true);
  assert.match(stuck.error, /stopped reporting.*send a follow-up/);
  const recent = await observeTui("reg-machine-7", "no_signal", idleSince(5), now);
  assert.equal(recent.turnState, undefined, "a short silence is not yet a failure");
  const busy = await observeTui("reg-machine-7", "no_signal", { state: "active", lastActivityAt: idleSince(120).lastActivityAt }, now);
  assert.equal(busy.turnState, undefined, "an agent still active is left running");
  report = "Done: registered.";
  const reported = await observeTui("reg-machine-7", "no_signal", idleSince(18 * 60), now);
  assert.equal(reported.turnState, "completed", "a report written before it went silent still counts");
  assert.equal(reported.answer, "Done: registered.");
});

test("a conversation too big for one response is read again with fewer items instead of failing every poll", async () => {
  const asked = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      const limit = Number(/limit=(\d+)/.exec(endpoint)[1]);
      asked.push(limit);
      if (limit > 40) throw new Error("AO response exceeds the handler limit (GET /api/v1/sessions/s/conversation)");
      return { turns: [{ id: "t", state: "running" }], activities: [],
        messages: [{ id: "m", role: "assistant", turnId: "t", sequence: 1, text: "still browsing" }] };
    },
  });
  const observed = await upstream.observe("s");
  assert.deepEqual(asked, [100, 40]);
  assert.equal(observed.turnState, "running");
  assert.equal(observed.liveOutput, "still browsing");
  const failing = observeHarness({ internalApi: async (_method, endpoint) => {
    if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
    throw new Error("AO is down");
  } });
  await assert.rejects(failing.observe("s"), /AO is down/, "other failures are not retried as size problems");
});

test("Claude Code's ExitPlanMode request carries its plan and every way it offered to go on", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "a1", turnId: "t", sequence: 2, activityKind: "approval", status: "pending", requestId: "req-plan", summary: "Ready to code?",
        createdAt: "2026-10-12T02:00:00Z",
        detail: { toolKind: "switch_mode", toolName: "ExitPlanMode", input: { plan: "## Plan\n1. Add /register\n2. Test it" },
          decisions: [{ id: "auto", kind: "allow_always", label: "Yes, and auto-accept" }, { id: "acceptEdits", kind: "allow_always", label: "Yes, and accept edits" },
            { id: "default", kind: "allow_once", label: "Yes, and manually approve edits" }, { id: "plan", kind: "reject_once", label: "No, keep planning" }] } }],
    } : { session: { id: "s", mode: "chat", status: "needs_input" } },
  });
  const [request] = JSON.parse(JSON.stringify((await upstream.observe("s")).approvals));
  assert.equal(request.kind, "plan");
  assert.equal(request.plan, "## Plan\n1. Add /register\n2. Test it");
  assert.equal(request.since, "2026-10-12T02:00:00Z");
  assert.deepEqual(request.decisions.map(decision => decision.id), ["auto", "acceptEdits", "default", "plan"]);
});

test("Claude Code's own tools are labelled by what they did, a shell call shows its command, and only a real MCP tool reads as MCP", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [
        { id: "1", turnId: "t", sequence: 1, activityKind: "mcp_tool", status: "completed", summary: "Read frontend\vite.config.ts", detail: { toolKind: "read", input: { file_path: "x" } } },
        { id: "2", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "Find `src`", detail: { toolKind: "search", input: { path: "src" } } },
        { id: "3", turnId: "t", sequence: 3, activityKind: "mcp_tool", status: "completed", summary: "PowerShell", detail: { toolKind: "other", input: { command: "Get-ChildItem frontend" } } },
        { id: "4", turnId: "t", sequence: 4, activityKind: "mcp_tool", status: "completed", summary: "Load skill: run", detail: { toolKind: "other", input: { skill: "run" } } },
        { id: "5", turnId: "t", sequence: 5, activityKind: "mcp_tool", status: "completed", summary: "mcp__playwright__browser_navigate", detail: { toolKind: "other", input: {} } },
        { id: "6", turnId: "t", sequence: 6, activityKind: "approval", status: "pending", requestId: "req-1", summary: "PowerShell",
          detail: { toolKind: "other", input: { command: "npm ci --prefix frontend", description: "安裝前端相依套件" },
            decisions: [{ id: "allow", kind: "allow_once", label: "Allow" }, { id: "no", kind: "reject_once", label: "Reject" }] } },
      ],
    } : { session: { id: "s", mode: "chat", status: "needs_input" } },
  });
  const observed = JSON.parse(JSON.stringify(await upstream.observe("s")));
  assert.deepEqual(observed.timeline.filter(item => item.kind !== "approval").map(item => [item.kind, item.label ?? null, item.text]), [
    ["tool", "Read", "Read frontend\vite.config.ts"],
    ["tool", "Search", "Find `src`"],
    ["command", null, "Get-ChildItem frontend"],
    ["tool", "Tool", "Load skill: run"],
    ["tool", "MCP", "mcp__playwright__browser_navigate"],
  ]);
  const [request] = observed.approvals;
  assert.equal(request.kind, "command", "a PowerShell call asks as a command");
  assert.equal(request.command, "npm ci --prefix frontend");
  assert.equal(request.tool, "PowerShell", "the tool's name, not ACP's \"other\"");
  assert.equal(request.reason, "安裝前端相依套件");
});

test("a tool request nobody answered says it timed out (or was cancelled), not just that the agent was blocked", async () => {
  const at = (minutes) => new Date(Date.parse("2026-10-12T06:17:42Z") + minutes * 60_000).toISOString();
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "completed" }], messages: [],
      activities: [
        { id: "1", turnId: "t", sequence: 87, activityKind: "approval", status: "completed", summary: "PowerShell",
          createdAt: at(0), updatedAt: at(30), detail: { resolvedBy: "provider" } },
        { id: "2", turnId: "t", sequence: 92, activityKind: "approval", status: "completed", summary: "PowerShell",
          createdAt: at(33), updatedAt: at(35), detail: { resolvedBy: "provider" } },
        { id: "3", turnId: "t", sequence: 95, activityKind: "approval", status: "completed", summary: "Edit",
          createdAt: at(40), updatedAt: at(41), detail: { decisionId: "allow" } },
      ],
    } : { session: { id: "s", mode: "chat", status: "idle" } },
  });
  const items = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.equal(items[0].label, "Approval timed out");
  assert.match(items[0].text, /Nobody answered within 30 minutes.*PowerShell.*follow-up/);
  assert.equal(items[1].label, "Approval cancelled", "the turn ended before it was answered");
  assert.equal(items[2].label, undefined, "a request the user answered keeps its normal row");
});
test("a reasoning item carries the model's summary text (AO keeps it in detail.text), not just the word Reasoning", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "r", turnId: "t", sequence: 1, activityKind: "reasoning", status: "completed", summary: "Reasoning",
        detail: { text: "**Inspecting the register route**\n\nThe form posts to /api/register; checking validation." } }],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const [item] = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.equal(item.kind, "reasoning");
  assert.match(item.text, /^\*\*Inspecting the register route\*\*/);
});