"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

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
// The module-level bounds and line diff the timeline helpers read (EDIT_DIFF_BYTES to lineChange).
function timelineBounds(source) {
  return source.slice(source.indexOf("// How much of an edit's diff"), source.indexOf("// Where a single-repo project's chats work"));
}

function observeHarness(context) {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async observe(id");
  const end = source.indexOf("    // A standalone AO terminal", start);
  const method = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  // These fixtures change AO's state and read it back at once: no shared read unless a test asks
  // for the app's real window (tailFreshMs).
  const shared = helpers.replace(/const TAIL_FRESH_MS = \d+;/, `const TAIL_FRESH_MS = ${Number(context.tailFreshMs ?? 0)};`);
  return vm.runInNewContext(states + timelineBounds(source) + shared + identity + "({" + method + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null,
    agentTools: null, setTimeout, exitedReleased: new Set(), observeTui: async () => { throw new Error("not a TUI fixture"); },
    logger: { info() {}, warn() {} },
    MAX_RESPONSE_BYTES: require("../electron/ipc-schema.cjs").MAX_RESPONSE_BYTES,
    // Imported by the module (not part of the helpers sliced above).
    utf8Suffix: require("../electron/chat-agent-shell.cjs").utf8Suffix, ...context,
  });
}

test("callers reading one session's conversation at once share one read, and a read serves for a moment", async () => {
  // Seen live: a busy chat's tail (~500-700 KB) was read twice a second by the chat, the mission
  // controller and the approval screen each: 58 MB a minute through the main process.
  let reads = 0;
  const upstream = observeHarness({ tailFreshMs: 900,
    internalApi: async (_method, endpoint) => {
      if (endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1")) {
        reads += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        return { turns: [{ id: "t", state: "running" }], messages: [] };
      }
      return { session: { id: "s", mode: "chat", status: "working" } };
    },
  });
  const [first, second] = await Promise.all([upstream.observe("s"), upstream.observe("s")]);
  assert.equal(first.turnState, "running");
  assert.equal(second.turnState, "running");
  assert.equal(reads, 1, "two callers at once, one read");
  await upstream.observe("s");
  assert.equal(reads, 1, "a read moments ago serves the next caller");
  await new Promise(resolve => setTimeout(resolve, 950));
  await upstream.observe("s");
  assert.equal(reads, 2, "then it is read again");
});

test("a fresh read of a session's newest 100 items serves the Terminal pane's ask for 60", async () => {
  // Seen live: a working chat's tail (~350 KB) was read each second by the run loop and every two
  // seconds by the Terminal pane, under separate keys.
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const endpoints = [];
  const { conversationTail } = vm.runInNewContext(`${timelineBounds(source)}${helpers}${identity}({ conversationTail })`, {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, agentTools: null,
    internalApi: async (_method, endpoint) => { endpoints.push(endpoint); return { messages: [], activities: [] }; },
  });
  await conversationTail("s");
  await conversationTail("s", [60, 20]);
  assert.deepEqual(endpoints.map(endpoint => /limit=(\d+)/.exec(endpoint)[1]), ["100"], "the 100-item read serves the 60-item ask");
  await conversationTail("other", [60, 20]);
  await conversationTail("other");
  assert.deepEqual(endpoints.map(endpoint => /limit=(\d+)/.exec(endpoint)[1]), ["100", "60", "100"], "a smaller read never serves a larger ask");
});

test("a slow tail read is shared while in flight and stays fresh three times as long as it took", async () => {
  // Seen live on 0.8.5: a 507 KB tail took ~620 ms; counted from its start, a result served only
  // ~280 ms after it landed and the session was read back to back (AO at 30-110% of a core).
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  let reads = 0, delay = 400;
  const { conversationTail } = vm.runInNewContext(`${timelineBounds(source)}${helpers}${identity}({ conversationTail })`, {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, agentTools: null,
    internalApi: async () => { reads += 1; await new Promise(resolve => setTimeout(resolve, delay)); return { messages: [], activities: [] }; },
  });
  const first = conversationTail("slow");
  await new Promise(resolve => setTimeout(resolve, 300));
  await Promise.all([first, conversationTail("slow")]);
  assert.equal(reads, 1, "a read still in flight is shared");
  await new Promise(resolve => setTimeout(resolve, 1000));
  await conversationTail("slow");
  assert.equal(reads, 1, "a 400 ms read still serves a second after it landed (3 x 400 ms)");
  delay = 5;
  await new Promise(resolve => setTimeout(resolve, 300));
  await conversationTail("slow");
  assert.equal(reads, 2, "then it is read again");
});

test("chat hosts that outlived the app are counted by whether their loopback address still answers", async () => {
  const vm = require("node:vm");
  const net = require("node:net");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  async function survivingChatHosts");
  const fn = source.slice(start, source.indexOf("  // continuable() checks in flight", start));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-chat-hosts-"));
  const live = net.createServer(socket => socket.destroy());
  await new Promise(resolve => live.listen(0, "127.0.0.1", resolve));
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const host = (id, record) => {
    fs.mkdirSync(path.join(dataRoot, "chat-hosts", id), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "chat-hosts", id, "host.json"), typeof record === "string" ? record : JSON.stringify(record));
  };
  try {
    const survivingChatHosts = vm.runInNewContext(`${fn}; survivingChatHosts`, { fs, path, net, dataRoot });
    assert.equal(await survivingChatHosts(), 0, "no chat-hosts folder");
    host("alive", { address: `127.0.0.1:${live.address().port}` });
    host("dead", { address: `127.0.0.1:${deadPort}` });
    host("broken", "{not json");
    host("remote", { address: "10.0.0.5:4000" });
    assert.equal(await survivingChatHosts(), 1, "only the host that still answers on loopback");
  } finally {
    await new Promise(resolve => live.close(resolve));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a session's project folder is named for its tools only for the chat's own folder-mode project", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  async function folderModeRoot");
  const fn = source.slice(start, source.indexOf("  const workspaceBoard =", start));
  const folder = path.resolve(os.tmpdir(), "ct-folder-mode-project");
  let project = { id: "p1", kind: "single_repo", path: folder, config: { workspaceMode: "folder" } };
  const folderModeRoot = vm.runInNewContext(`${fn}; folderModeRoot`, {
    path, process,
    workspaceBoard: { project: async (workspaceId) => ({ projectId: workspaceId === "w1" ? "p1" : "p2" }) },
    internalApi: async (_method, endpoint) => (endpoint.endsWith("/p1") ? { project } : { project: null }),
  });
  const session = { projectId: "p1" };
  assert.equal(await folderModeRoot(session, folder, "w1"), folder);
  assert.equal(await folderModeRoot(session, `${folder}${path.sep}`, "w1"), folder, "a trailing separator is the same folder");
  assert.equal(await folderModeRoot(session, path.join(folder, "sub"), "w1"), null, "only the folder itself");
  assert.equal(await folderModeRoot(session, folder, "w2"), null, "another workspace's chat");
  assert.equal(await folderModeRoot({ projectId: "p9" }, folder, "w1"), null, "a session of another project");
  assert.equal(await folderModeRoot(session, folder, null), null, "no chat workspace");
  project = { ...project, config: { workspaceMode: "worktree" } };
  assert.equal(await folderModeRoot(session, folder, "w1"), null, "a project that chose worktrees");
  project = { ...project, config: {} };
  assert.equal(await folderModeRoot(session, folder, "w1"), null, "a project that never chose");
});

test("the folder default waits behind the project's dependency-link sync only when it has to write", async () => {
  // Seen live: the first launch in a project after the app started waited 19 s behind its link
  // sync just to read a mode that was already "folder".
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  const folderModeChecked = new Set();");
  const fn = source.slice(start, source.indexOf("  /** The project folder a folder-mode session works in", start));
  const calls = [];
  const stored = { p2: { id: "p2", kind: "single_repo", config: { workspaceMode: "worktree" } }, p3: { id: "p3", kind: "single_repo", config: { other: 1 } } };
  const defaultToFolderMode = vm.runInNewContext(`${fn}; defaultToFolderMode`, {
    internalApi: async (method, endpoint, body) => {
      calls.push(`${method} ${endpoint}`);
      return method === "GET" ? { project: stored[endpoint.split("/").pop()] } : { ok: true, body };
    },
    dependencyLinks: { exclusive: async (_id, work) => { calls.push("queued"); return work(); } },
  });
  await defaultToFolderMode({ id: "p1", kind: "single_repo", config: { workspaceMode: "folder" } });
  assert.deepEqual(calls, [], "a mode the project list already shows needs no read and no queue");
  await defaultToFolderMode({ id: "p2", kind: "single_repo" });
  assert.deepEqual(calls, ["GET /api/v1/projects/p2"], "a chosen mode is read once, outside the queue");
  calls.length = 0;
  await defaultToFolderMode({ id: "p3", kind: "single_repo" });
  assert.deepEqual(calls, ["GET /api/v1/projects/p3", "queued", "GET /api/v1/projects/p3", "PUT /api/v1/projects/p3/config"],
    "only a project that never chose is written, on the sync's queue");
  calls.length = 0;
  await defaultToFolderMode({ id: "p3", kind: "single_repo" });
  assert.deepEqual(calls, [], "checked once per project");
});

test("a workspace's known AO project is used at once while its binding is refreshed behind the launch", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  async function projectFor");
  const fn = source.slice(start, source.indexOf("  async function chatTools", start));
  let clock = 1_000_000, binds = 0;
  const pending = [];
  const { projectFor, forgetProject } = vm.runInNewContext(`${fn}; ({ projectFor, forgetProject })`, {
    Map, Error, Date: { now: () => clock },
    workspaceBoard: { bind: () => { binds += 1; return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
  });
  const first = projectFor("w1");
  pending.shift().resolve({ projectId: "p1" });
  assert.equal(await first, "p1", "the first launch waits for its binding");
  assert.equal(await projectFor("w1"), "p1");
  assert.equal(binds, 1, "kept for a minute");
  clock += 61_000;
  assert.equal(await projectFor("w1"), "p1", "a stale binding answers at once");
  assert.equal(binds, 2, "and is refreshed");
  assert.equal(await projectFor("w1"), "p1", "a launch during the refresh does not wait for it either");
  assert.equal(binds, 2);
  pending.shift().reject(new Error("AO project registration failed"));
  await new Promise((resolve) => setImmediate(resolve));
  const afresh = projectFor("w1");
  assert.equal(binds, 3, "a failed refresh is forgotten; the next launch binds afresh");
  pending.shift().resolve({ projectId: "p9" });
  assert.equal(await afresh, "p9");
  forgetProject("w1");
  const again = projectFor("w1");
  pending.shift().resolve({ projectId: "p9" });
  assert.equal(await again, "p9");
  assert.equal(binds, 4, "a forgotten binding (a failed start) is waited for again");
});

test("a session AO runs in the chat workspace's own folder is named a project folder, whatever its project lookup says", async () => {
  // Seen live (project "reg-machine"): an exec_command failed with "not one of AO's worktrees"
  // although the chat ran in the project's own folder; the folder-mode lookup could not confirm it.
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  async function workspaceFolderRoot");
  const fn = source.slice(start, source.indexOf("  const workspaceBoard =", start));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ct-workspace-folder-"));
  const folder = path.join(base, "reg-machine");
  fs.mkdirSync(path.join(folder, "sub"), { recursive: true });
  fs.mkdirSync(path.join(base, "other"));
  try {
    const workspaceFolderRoot = vm.runInNewContext(`${fn}; workspaceFolderRoot`, {
      path, fs, process, getWorkspaces: async () => [{ id: "w1", path: folder }, { id: "w2", path: path.join(base, "other") }],
    });
    assert.equal(await workspaceFolderRoot(folder, "w1"), folder);
    assert.equal(await workspaceFolderRoot(`${folder}${path.sep}`, "w1"), folder, "a trailing separator is the same folder");
    assert.equal(await workspaceFolderRoot(path.join(folder, "sub", ".."), "w1"), folder, "the same folder by another spelling");
    assert.equal(await workspaceFolderRoot(path.join(folder, "sub"), "w1"), null, "only the folder itself");
    assert.equal(await workspaceFolderRoot(folder, "w2"), null, "another workspace's folder");
    assert.equal(await workspaceFolderRoot(folder, "w9"), null, "an unknown workspace");
    assert.equal(await workspaceFolderRoot(folder, null), null, "no chat workspace");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

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
      if (endpoint === "/api/v1/sessions/owned-session/conversation?limit=100&includePending=1&trimLargeFields=1") return { turns: [{ id: turn, state: "running" }], messages };
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

test("a pending item too large for any page still lets the chat be read (and stopped)", async () => {
  // Seen live: a stuck 1 MB screenshot call was pending, so includePending put it in every page,
  // every read exceeded the handler limit, and Stop failed with "AO response exceeds the handler limit".
  const asked = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      asked.push(endpoint.split("?")[1]);
      if (endpoint.includes("includePending=1&trimLargeFields=1")) throw new Error("AO response exceeds the handler limit (GET /api/v1/sessions/s/conversation)");
      return { turns: [{ id: "t", state: "running" }], messages: [] };
    },
  });
  const observed = await upstream.observe("s");
  assert.equal(observed.turnState, "running");
  // The second limit=10 read is the one with room for big items (compactConversation).
  assert.deepEqual(asked, ["limit=100&includePending=1&trimLargeFields=1", "limit=40&includePending=1&trimLargeFields=1", "limit=10&includePending=1&trimLargeFields=1",
    "limit=10&includePending=1&trimLargeFields=1", "limit=3&includePending=1&trimLargeFields=1", "limit=1&includePending=1&trimLargeFields=1", "limit=10"]);
});

test("one item over the limit among the newest ten no longer hides what came after it", async () => {
  // Seen live (clash-of-clan-macro-60): a 1.3 MB MCP page dump was among the newest 10 items, so the
  // reads of 100, 40 and 10 all failed, the chat showed "AO response exceeds the handler limit", and
  // the pending approval behind it was never seen or answered: "may be stuck" for 3 hours.
  const asked = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      asked.push(endpoint.split("?")[1]);
      if (Number(/limit=(\d+)/.exec(endpoint)[1]) >= 10) throw new Error("AO response exceeds the handler limit (GET /api/v1/sessions/s/conversation)");
      return { turns: [{ id: "t", state: "running" }], messages: [] };
    },
  });
  const observed = await upstream.observe("s");
  assert.equal(observed.turnState, "running");
  assert.deepEqual(asked, ["limit=100&includePending=1&trimLargeFields=1", "limit=40&includePending=1&trimLargeFields=1", "limit=10&includePending=1&trimLargeFields=1",
    "limit=10&includePending=1&trimLargeFields=1", "limit=3&includePending=1&trimLargeFields=1"], "three items, pending ones included, get past it");
});

test("a newest item over the limit on its own still fails the read, after every smaller page", async () => {
  const asked = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      asked.push(endpoint.split("?")[1]);
      throw new Error("AO response exceeds the handler limit (GET /api/v1/sessions/s/conversation)");
    },
  });
  await assert.rejects(upstream.observe("s"), /exceeds the handler limit/);
  assert.deepEqual(asked.slice(-3), ["limit=10", "limit=3", "limit=1"]);
});

test("observe shows the reply of a turn that ended while AO still flagged it as streaming", async () => {
  // Seen live: a provider error ended the turn mid-stream and AO kept streaming=true on its reply.
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "failed", errorMessage: "provider error" }],
      messages: [
        { id: "m0", role: "user", turnId: "t", sequence: 1, text: "the prompt" },
        { id: "m1", role: "assistant", turnId: "t", sequence: 2, text: "API Error: Request rejected (429)", streaming: true },
      ],
    } : { session: { id: "s", mode: "chat", status: "idle" } },
  });
  const observed = await upstream.observe("s");
  assert.equal(observed.answer, "API Error: Request rejected (429)");
  assert.equal(JSON.stringify(observed.timeline.map((item) => item.status)), '["completed"]');
});

test("a turn AO failed because its controller died with the app reads as a restart interruption", async () => {
  // Seen live after an in-app update: AO's daemon closed with the app and, starting again, failed
  // the running turn as "controller ended before the turn completed"; the chat could not resume it.
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "failed", errorMessage: "controller ended before the turn completed" }],
      messages: [{ id: "m0", role: "user", turnId: "t", sequence: 1, text: "the prompt" }],
    } : { session: { id: "s", mode: "chat", status: "idle" } },
  });
  const observed = await upstream.observe("s");
  assert.equal(observed.turnState, "interrupted");
  assert.match(observed.error, /process ended before it finished \(the app restarted\)/);
});

test("observe returns the current turn's reasoning, tool calls and messages in order", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
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
      if (endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1")) return { turns: [{ id: "t", state: turnState }], messages: [] };
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
  for (const operation of ["chat_send", "chat_goal", "chat_loop", "chat_queue", "compact_chat", "chat_diff", "chat_delete_message", "runs"]) assert.ok(called.has(operation), `${operation} is called`);
  const unknown = [...called].filter(operation => !handler.operations.includes(operation));
  assert.deepEqual(unknown, [], "an operation missing here fails in the app as \"Unknown Agent Orchestrator operation\"");
  assert.equal(handler.isReadOnly("chat_diff"), true);
  assert.equal(handler.isReadOnly("chat_goal"), false);
  assert.equal(handler.isReadOnly("chat_loop"), false);
  // Queuing is the person's typing: it needs the focused window, as a send does.
  assert.equal(handler.isReadOnly("chat_queue"), false);
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
      if (endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1")) return {
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

// Seen live: "IPC_RESPONSE_SCHEMA_INVALID: $.result.status.pending_approvals[0].turn_id must be a JSON
// value": a request AO held outside a turn carried turn_id: undefined, and the whole status read failed.
test("a request AO holds outside a turn has no turn_id key, so the status read passes the IPC schema", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [
        { id: "a1", sequence: 2, activityKind: "approval", status: "pending", requestId: "req-1", summary: "Bash",
          detail: { toolKind: "execute", toolName: "Bash", input: { command: "dir" }, decisions: [{ id: "allow", kind: "allow_once" }] } },
        { id: "a2", sequence: 3, activityKind: "user_input", status: "pending", requestId: "q-1", summary: "Which?",
          detail: { message: "Which?", schema: { properties: { pick: { type: "string" } } } } },
      ],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const observed = await upstream.observe("s");
  assert.equal(observed.approvals.length, 2);
  for (const item of observed.approvals) assert.ok(!Object.hasOwn(item, "turn_id"), `${item.approval_id} has no turn_id key`);
  const { snapshotJsonPayload } = require("../electron/ipc-schema.cjs");
  if (typeof snapshotJsonPayload === "function") {
    assert.doesNotThrow(() => snapshotJsonPayload({ status: { pending_approvals: observed.approvals } }, "IPC_RESPONSE_SCHEMA_INVALID", { rejectSensitiveKeys: true }));
  }
});

// Seen live: AO's ACP approval for the app's exec_command had no toolName (subjectKind "mcp_tool",
// toolKind "other"); the name was only the summary. The input was dropped, so "Approve for me"'s
// reviewer saw no command, answered "ask", and the chat waited on the person for a bare `cd`.
test("approval commands and JSON stay whole for display while retaining the reviewer bounds", async () => {
  const inputs = [
    { command: "python -c \"" + "x".repeat(1491) + "\"" },
    { command: "x".repeat(4001) },
    { cmd: "x".repeat(2000) },
    { path: "x".repeat(1001) },
  ];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: inputs.map((input, index) => ({ activityKind: "approval", status: "pending", requestId: "req-" + index,
        summary: index === 2 ? "mcp__coding-tools__exec_command" : "PowerShell",
        detail: { input, decisions: [{ id: "allow", kind: "allow_once" }] } })),
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const approvals = (await upstream.observe("s")).approvals;
  assert.equal(approvals[0].command, inputs[0].command, "a complete native script keeps every character");
  assert.equal(approvals[0].reviewTruncated, undefined);
  assert.equal(approvals[1].command, inputs[1].command);
  assert.equal(approvals[2].toolInput, JSON.stringify(inputs[2]));
  assert.equal(approvals[3].path.length, 1000);
  assert.ok(approvals.slice(1).every(approval => approval.reviewTruncated === true));
});

test("a server-trimmed approval reads only its exact raw activity and keeps a Unicode command beyond 64 KiB", async () => {
  const command = "python - <<'PY'\r\n" + "print('界😀')\r\n".repeat(6000) + "# FINAL_APPROVAL_SENTINEL\r\nPY";
  assert.ok(Buffer.byteLength(command, "utf8") > 64 * 1024);
  const activity = { id: "a", turnId: "t", sequence: 41, activityKind: "approval", status: "pending", requestId: "req-long", summary: "Bash",
    detail: { input: { command }, decisions: [{ id: "allow", kind: "allow_once" }] } };
  const clipped = { ...activity, detail: { ...activity.detail, input: { command: command.slice(0, 2000) + "\n… [90000 bytes omitted] …\n" + command.slice(-16000) } } };
  const requests = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint, _body, options) => {
      requests.push([endpoint, options]);
      if (endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1")) {
        return { turns: [{ id: "t", state: "running" }], messages: [], activities: [clipped] };
      }
      if (endpoint.endsWith("/conversation?limit=1&beforeSequence=42")) {
        assert.equal(options.maxBytes, 32 * 1024 * 1024);
        assert.equal(options.preserveInlineBlobs, true);
        // Even if an older daemon ignores pagination, no unrelated raw data reaches the window.
        return { messages: [{ text: "UNRELATED_RAW_HISTORY".repeat(100000) }], activities: [activity,
          { id: "other", activityKind: "command", detail: { output: "UNRELATED_RAW_OUTPUT".repeat(100000) } }] };
      }
      return { session: { id: "s", mode: "chat", status: "working" } };
    },
  });
  const observed = await upstream.observe("s");
  assert.equal(observed.approvals[0].command, command);
  assert.equal(observed.approvals[0].reviewTruncated, true, "the old reviewer limit still requires manual review");
  assert.equal(observed.approvals[0].command.endsWith("# FINAL_APPROVAL_SENTINEL\r\nPY"), true);
  assert.doesNotMatch(JSON.stringify(observed), /UNRELATED_RAW_/);
  assert.equal(requests.filter(([endpoint]) => endpoint.includes("beforeSequence=")).length, 1);
});

test("a pending approval fails closed when its original raw input cannot be verified", async () => {
  const activity = { id: "a", turnId: "t", sequence: 41, activityKind: "approval", status: "pending", requestId: "req-long", summary: "Bash",
    detail: { input: { command: "head\n… [90000 bytes omitted] …\ntail" }, decisions: [{ id: "allow", kind: "allow_once" }] } };
  const mismatches = [
    { id: "other" }, { requestId: "other" }, { turnId: "other" }, { sequence: 42 }, { status: "resolved" },
  ];
  for (const mismatch of [...mismatches, null]) {
    const upstream = observeHarness({
      internalApi: async (_method, endpoint) => {
        if (endpoint.includes("trimLargeFields=1")) return { turns: [{ id: "t", state: "running" }], messages: [], activities: [activity] };
        if (endpoint.includes("beforeSequence=")) {
          if (!mismatch) throw new Error("Raw conversation read failed");
          return { activities: [{ ...activity, ...mismatch, detail: { ...activity.detail, input: { command: "different command" } } }] };
        }
        return { session: { id: "s", mode: "chat", status: "working" } };
      },
    });
    await assert.rejects(upstream.observe("s"), /full approval input is unavailable/);
  }
});

test("a full pending approval exceeding the existing IPC limit fails instead of being clipped", async () => {
  const activity = { id: "a", turnId: "t", sequence: 41, activityKind: "approval", status: "pending", requestId: "req-long", summary: "Bash",
    detail: { input: { command: "head\n… [90000 bytes omitted] …\ntail" }, decisions: [{ id: "allow", kind: "allow_once" }] } };
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      if (endpoint.includes("trimLargeFields=1")) return { turns: [{ id: "t", state: "running" }], messages: [], activities: [activity] };
      if (endpoint.includes("beforeSequence=")) return { activities: [{ ...activity, detail: { ...activity.detail, input: { command: "😀".repeat(300000) } } }] };
      return { session: { id: "s", mode: "chat", status: "working" } };
    },
  });
  await assert.rejects(upstream.observe("s"), /full approval input exceeds the app's response limit/);
});

test("only the targeted raw approval read preserves inline-looking input", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const method = source.slice(source.indexOf("  async function requestApi"), source.indexOf("  // AO's error envelope"));
  const command = "A".repeat(70000);
  const requestApi = require("node:vm").runInNewContext(method + "requestApi", {
    Buffer, AbortSignal, state: "ready", daemonPort: 1, AO_RESPONSE_MAX_BYTES: 16 * 1024 * 1024,
    dropInlineBlobs: require("../electron/agent-orchestrator-upstream.cjs").dropInlineBlobs,
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ activities: [{ detail: { input: { command } } }] }) }),
  });
  const normal = await requestApi("GET", "/api/v1/sessions/s/conversation?limit=100&trimLargeFields=1");
  assert.match(normal.data.activities[0].detail.input.command, /inline binary data not shown/);
  const raw = await requestApi("GET", "/api/v1/sessions/s/conversation?limit=1&beforeSequence=42", undefined,
    { maxBytes: 32 * 1024 * 1024, preserveInlineBlobs: true });
  assert.equal(raw.data.activities[0].detail.input.command, command);
});

test("an MCP tool approval named only by its summary keeps its input for the reviewer", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "a1", turnId: "t", sequence: 2, activityKind: "approval", status: "pending", requestId: "req-cd",
        summary: "mcp__coding-tools__exec_command",
        detail: { subjectKind: "mcp_tool", toolKind: "other", protocol: "acp", input: { cmd: "cd" },
          decisions: [{ id: "allow", kind: "allow_once", label: "Allow" }, { id: "no", kind: "reject_once", label: "Reject" }] } }],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const [approval] = JSON.parse(JSON.stringify((await upstream.observe("s")).approvals));
  assert.equal(approval.tool, "mcp__coding-tools__exec_command");
  assert.equal(approval.toolInput, '{"cmd":"cd"}');
});

test("native Edit and Write approvals retain the complete code beside their file path", async () => {
  const oldText = "const before = '界😀';\r\n".repeat(100) + "// ORIGINAL_SOURCE_SENTINEL";
  const newText = "const after = '界😀';\r\n".repeat(100) + "// CHANGED_SOURCE_SENTINEL";
  const requests = [
    { tool: "Edit", input: { file_path: "src/existing.ts", old_string: oldText, new_string: newText } },
    { tool: "Write", input: { file_path: "src/created.ts", content: newText } },
  ];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: requests.map(({ tool, input }, index) => ({ id: "edit-" + index, turnId: "t", sequence: index + 1,
        activityKind: "approval", status: "pending", requestId: "req-" + index, summary: tool,
        detail: { toolName: tool, input, decisions: [{ id: "allow", kind: "allow_once" }] } })),
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const approvals = (await upstream.observe("s")).approvals;
  for (const [index, approval] of approvals.entries()) {
    assert.equal(approval.path, requests[index].input.file_path);
    assert.equal(approval.toolInput, JSON.stringify(requests[index].input));
    assert.equal(approval.reviewTruncated, true);
  }
  const edit = JSON.parse(approvals[0].toolInput);
  assert.equal(edit.old_string, oldText);
  assert.equal(edit.new_string, newText);
  assert.equal(JSON.parse(approvals[1].toolInput).content, newText);
});

test("a harness tool's own arguments stay whole; a command or file keeps its existing display", async () => {
  // The user: "when new chat harness tools came out ... it keeps asking for permission". Claude Code's
  // newer tools (Monitor, WebFetch) reached the reviewer as a bare name, so it judged them blind.
  const inputs = [
    { tool: "WebFetch", input: { url: "http://127.0.0.1:5173/", prompt: "Is the page up?" } },
    { tool: "Bash", input: { command: "npm test", description: "Run the tests" } },
    { tool: "Read", input: { file_path: "C:/repo/a.txt" } },
    { tool: "Skill", input: { skill: "x".repeat(1600) } },
    { tool: "SomeNewTool", input: {} },
  ];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: inputs.map(({ tool, input }, index) => ({ activityKind: "approval", status: "pending", requestId: "req-" + index,
        summary: tool, detail: { toolName: tool, input, decisions: [{ id: "allow", kind: "allow_once" }] } })),
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const approvals = JSON.parse(JSON.stringify((await upstream.observe("s")).approvals));
  assert.equal(approvals[0].toolInput, JSON.stringify(inputs[0].input));
  assert.equal(approvals[0].kind, "permission");
  assert.equal(approvals[1].toolInput, undefined, "a command is shown as the command");
  assert.equal(approvals[1].command, "npm test");
  assert.equal(approvals[2].toolInput, JSON.stringify(inputs[2].input), "the file arguments remain inspectable beside the path");
  assert.equal(approvals[2].path, "C:/repo/a.txt");
  assert.equal(approvals[3].toolInput, JSON.stringify(inputs[3].input), "the person can inspect the whole input");
  assert.equal(approvals[3].reviewTruncated, true, "a long input still waits for manual review");
  assert.equal(approvals[4].toolInput, undefined, "no arguments, nothing to show");
});

test("a follow-up turn is observed only once AO shows it; send and steer use AO's conversation routes", async () => {
  const calls = [];
  let turns = [{ id: "old", state: "completed" }];
  let steerError = null;
  const upstream = observeHarness({
    internalApi: async (method, endpoint, body) => {
      calls.push([method, endpoint, body]);
      if (endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1")) return { turns,
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
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "s1", turnId: "t", sequence: 3, activityKind: "system", status: "completed", summary: "use pnpm…",
        detail: { event: "steer", text: "use pnpm, not npm" } },
        { id: "c1", turnId: "t", sequence: 2, activityKind: "system", status: "completed", summary: "Context compacted", detail: { event: "compaction" } }],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const timeline = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.deepEqual(timeline.map(item => [item.kind, item.text]), [["system", "Context compacted"], ["steer", "use pnpm, not npm"]]);
});

test("a provider retry says why it retries, such as a rate limit", async () => {
  // As AO stored it live (coding-tools-mcp-27): the summary alone never said it was a 429.
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "r1", turnId: "t", sequence: 2, activityKind: "system", status: "running", summary: "Retrying Claude, attempt 2 of 10.",
        detail: { category: "limit", event: "provider.failure", severity: "warning", text: "API error 429. Trying again in 1s." } }],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const timeline = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.deepEqual(timeline.map(item => [item.kind, item.text]),
    [["system", "Retrying Claude, attempt 2 of 10. API error 429. Trying again in 1s."]]);
});

test("a turn that only retries its model request shows no new sign of life, so a message can restart it", async () => {
  // Claude Code stuck on 503s: a "Retrying Claude, attempt n of 10" notice every few seconds and
  // nothing else. Each notice refreshed lastActivityAt, so chat_steer never saw the hang.
  const at = minutes => new Date(Date.parse("2026-10-18T10:00:00Z") + minutes * 60_000).toISOString();
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      // AO may touch the turn itself with each activity, retries included.
      turns: [{ id: "t", state: "running", createdAt: at(0), startedAt: at(0), updatedAt: at(5) }],
      messages: [{ id: "m", turnId: "t", role: "assistant", text: "Looking at the parser.", streaming: false, createdAt: at(1), updatedAt: at(1) }],
      activities: [
        { id: "a1", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "Read", createdAt: at(1.5), updatedAt: at(1.5), detail: {} },
        { id: "r1", turnId: "t", sequence: 3, activityKind: "system", status: "running", summary: "Retrying Claude, attempt 7 of 10.",
          createdAt: at(2), updatedAt: at(5), detail: { event: "provider.failure", severity: "warning", text: "API error 503. Trying again in 30s." } },
      ],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  assert.equal((await upstream.observe("s")).lastActivityAt, Date.parse(at(1.5)), "the last real step, not the retry notices after it");
});

test("a screenshot tool's row shows its picture and what it said, not the picture's base64", async () => {
  // Seen live (preview_screenshot, 2026-10-21): AO's `output` for an image result is the provider's
  // JSON with the PNG as base64; the row showed none of it. Its content carries the image, the file
  // Claude Code saved it to, and the page's url and title.
  const base64 = "iVBORw0KGgo".repeat(15000);
  const screenshot = { id: "a1", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "mcp__coding-tools__preview_screenshot",
    detail: { input: {}, toolKind: "other", providerToolName: "mcp__coding-tools__preview_screenshot",
      output: JSON.stringify([{ source: { data: base64 } }]),
      content: [
        { type: "content", content: { type: "image", mimeType: "image/png", data: base64 } },
        { type: "content", content: { type: "text", text: "[Image: source: C:\\Users\\me\\.claude\\projects\\p\\tool-results\\shot.png]" } },
        { type: "content", content: { type: "text", text: "{\"url\":\"http://127.0.0.1:8000/register\",\"title\":\"frontend\"}" } },
      ] } };
  // A picture that came back with no saved copy is still said, rather than shown as nothing.
  const unsaved = { ...screenshot, id: "a2", sequence: 3, detail: { ...screenshot.detail, content: [screenshot.detail.content[0]] } };
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation")
      ? { turns: [{ id: "t", state: "running" }], messages: [], activities: [screenshot, unsaved] }
      : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const [shot, bare] = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.deepEqual(shot.images, ["C:\\Users\\me\\.claude\\projects\\p\\tool-results\\shot.png"]);
  assert.equal(shot.output, "{\"url\":\"http://127.0.0.1:8000/register\",\"title\":\"frontend\"}");
  assert.equal(shot.input, undefined, "the tool takes no arguments");
  assert.equal(bare.images, undefined);
  assert.match(bare.output, /An image came back/);
  assert.ok(!bare.output.includes("iVBOR"));
});

test("a tool's row carries its arguments and output well past a few lines", async () => {
  const file = Array.from({ length: 300 }, (_, line) => `${line + 1}\tconst value${line} = ${line};`).join("\n");
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation")
      ? { turns: [{ id: "t", state: "running" }], messages: [], activities: [{ id: "a1", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed",
        summary: "Read src/app.ts", detail: { input: { file_path: "src/app.ts", limit: 300 }, toolKind: "read", output: file } }] }
      : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const [read] = (await upstream.observe("s")).timeline;
  assert.ok(Buffer.byteLength(read.output) > 2000, "more than the old 2 KB cut");
  assert.ok(read.output.length <= 16 * 1024);
});

test("observe says when the tool call still running began, so a steer can stop a long one", async () => {
  const at = minutes => new Date(Date.parse("2026-10-20T04:00:00Z") + minutes * 60_000).toISOString();
  const conversation = (activities) => observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "t", state: "running", createdAt: at(0), startedAt: at(0) }], messages: [], activities,
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const running = await conversation([
    { id: "a1", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "Read", createdAt: at(1), updatedAt: at(1), detail: {} },
    { id: "a2", turnId: "t", sequence: 3, activityKind: "mcp_tool", status: "running", summary: "Bash", createdAt: at(2), updatedAt: at(4),
      detail: { input: { command: "npm test" } } },
    { id: "r1", turnId: "t", sequence: 4, activityKind: "system", status: "running", summary: "Retrying Claude", createdAt: at(1.5), detail: {} },
  ]).observe("s");
  assert.equal(running.toolSince, Date.parse(at(2)), "the running command's start; a finished call and a notice are not tool calls in flight");
  const idle = await conversation([
    { id: "a1", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "Read", createdAt: at(1), updatedAt: at(1), detail: {} },
  ]).observe("s");
  assert.equal(idle.toolSince, undefined, "no tool call in flight");
});

test("observe reports the whole session's last sign of life and tool calls, for a turn queued behind another", async () => {
  // A message queued behind a working turn has no activity of its own (2026-10-31).
  const at = minutes => new Date(Date.parse("2026-10-31T11:00:00Z") + minutes * 60_000).toISOString();
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.endsWith("/conversation?limit=100&includePending=1&trimLargeFields=1") ? {
      turns: [{ id: "working", state: "running", createdAt: at(0), startedAt: at(0) }, { id: "queued", state: "queued", createdAt: at(9) }],
      messages: [{ id: "m", turnId: "working", role: "assistant", text: "Checking the window.", streaming: false, createdAt: at(1), updatedAt: at(1) }],
      activities: [
        { id: "a1", turnId: "working", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "Read", createdAt: at(10), updatedAt: at(14), detail: {} },
        { id: "a2", turnId: "working", sequence: 3, activityKind: "mcp_tool", status: "running", summary: "Bash", createdAt: at(15), updatedAt: at(15),
          detail: { input: { command: "python macro.py", timeout: 600_000 } } },
        { id: "r1", turnId: "working", sequence: 4, activityKind: "system", status: "running", summary: "Retrying Claude", createdAt: at(16), updatedAt: at(20),
          detail: { event: "provider.failure", text: "API error 503." } },
      ],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const observed = await upstream.observe("s", "queued");
  assert.equal(observed.turnState, "queued");
  assert.equal(observed.lastActivityAt, Date.parse(at(9)), "the queued turn alone shows only when it was asked");
  assert.equal(observed.sessionActivityAt, Date.parse(at(15)), "the session's newest real step, not the retry notice after it");
  assert.deepEqual(JSON.parse(JSON.stringify(observed.sessionTools)), [{ timeoutMs: 600_000 }], "the command in flight in the turn ahead, with its own timeout");
});

test("exitAgent requires the selected agent's acknowledged exited state", async () => {
  for (const outcome of [{ ok: false }, { ok: true }, { ok: true, session: { id: "s", status: "working" } }, { ok: true, session: { id: "other", status: "exited" } }]) {
    const upstream = observeHarness({ internalApi: async () => outcome });
    await assert.rejects(upstream.exitAgent("s"), /shutdown is unconfirmed/);
  }
  const upstream = observeHarness({ internalApi: async () => ({ ok: true, session: { id: "s", status: "exited" } }) });
  assert.equal((await upstream.exitAgent("s")).ok, true);
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
  const calls = [], resumeWaits = [];
  let resumeOk = true, exitOk = true, resumeTimesOut = false, busyAnswers = 0, exitBusy = 0;
  let status = "exited";
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, Date, Math, Number, Promise, agentTools: null,
    exitedReleased: new Set(), logger: null, setTimeout: (resolve) => { resolve(); return 0; },
    internalApi: async (method, endpoint, body, options) => {
      calls.push([method, endpoint]);
      if (endpoint.endsWith("/resume-agent")) resumeWaits.push(options?.timeoutMs);
      if (endpoint.endsWith("/resume-agent") && busyAnswers > 0) {
        busyAnswers -= 1;
        throw Object.assign(new Error("The service is momentarily unavailable, please retry."), { status: 503, code: "SERVICE_UNAVAILABLE" });
      }
      if (endpoint.endsWith("/resume-agent") && resumeTimesOut) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (endpoint === "/api/v1/sessions") return { sessions };
      const id = endpoint.split("/")[4];
      if (endpoint.endsWith("/conversation?limit=1")) return { turns: turns[id] ?? [] };
      if (endpoint.endsWith("/exit-agent")) {
        if (exitBusy > 0) {
          exitBusy -= 1;
          throw Object.assign(new Error("The agent is already exiting"), { status: 409, code: "AGENT_EXIT_IN_PROGRESS" });
        }
        if (!exitOk) throw new Error("exit failed");
        return { ok: true, session: { id, status: "exited" } };
      }
      if (endpoint.endsWith("/resume-agent")) { if (!resumeOk) throw new Error("resume failed"); status = "idle"; return { ok: true }; }
      return { session: { id, mode: "chat", status } };
    },
  });
  assert.deepEqual([...await upstream.idleChatSessions(30 * 60_000, now)], ["old"],
    "only a chat agent idle past the limit; a recent turn or message, a never-used (pre-warmed), working, TUI or terminated session is kept");
  await upstream.exitAgent("old");
  assert.deepEqual(calls.at(-1), ["POST", "/api/v1/sessions/old/exit-agent"]);
  exitBusy = 3; calls.length = 0;
  assert.equal((await upstream.exitAgent("old")).ok, true,
    "a stop or start already holding the agent is waited out, not failed: that failed every launch retry on 2026-10-30");
  assert.equal(calls.filter(([, endpoint]) => endpoint.endsWith("/exit-agent")).length, 4);
  exitBusy = 99;
  await assert.rejects(upstream.exitAgent("old"), error => error.code === "AGENT_EXIT_IN_PROGRESS", "the wait is bounded");
  exitBusy = 0;
  assert.equal(await upstream.continuable("old"), true, "a released agent is resumed for the next message");
  assert.ok(calls.some(([method, endpoint]) => method === "POST" && endpoint === "/api/v1/sessions/old/resume-agent"));
  status = "exited"; busyAnswers = 2; calls.length = 0;
  assert.equal(await upstream.continuable("old"), true, "AO's database being busy (503) is waited out, not read as an agent that did not come back");
  assert.deepEqual(calls.filter(([method]) => method === "POST").map(([, endpoint]) => endpoint.split("/").at(-1)),
    ["resume-agent", "resume-agent", "resume-agent"], "no stop and no fresh agent");
  status = "exited"; resumeOk = false; calls.length = 0;
  assert.equal(await upstream.continuable("old"), false,
    "an agent that cannot be confirmed back is stopped, tried once more, then the message starts a fresh agent");
  const posts = calls.filter(([method]) => method === "POST").map(([, endpoint]) => endpoint.split("/").at(-1));
  assert.deepEqual(posts, ["resume-agent", "exit-agent", "resume-agent", "exit-agent"]);
  assert.ok(resumeWaits.every(ms => ms === 90_000), "a resume waits 90 s, not the 180 s POST default");
  status = "exited"; resumeOk = true; resumeTimesOut = true; calls.length = 0;
  assert.equal(await upstream.continuable("old"), false,
    "a resume that timed out is stopped and the message starts a fresh agent without a second 90 s wait");
  assert.deepEqual(calls.filter(([method]) => method === "POST").map(([, endpoint]) => endpoint.split("/").at(-1)),
    ["resume-agent", "exit-agent"]);
  resumeTimesOut = false; resumeOk = false;
  exitOk = false;
  await assert.rejects(upstream.continuable("old"), error => error.code === "AO_SESSION_RESTORE_UNCONFIRMED",
    "one that cannot be stopped either may still come back, so no second agent is started beside it");
});

test("a chat AO could not reconnect after a restart is resumed before a message, and released when left alone", async () => {
  // Seen live 2026-10-31: an update restarted AO while the old one still held two chats' agents, so
  // the new one could not reconnect them ("unavailable") and kept them live. The retry's message failed
  // CHAT_CONTROLLER_NOT_READY, went to a fresh agent, and the old agents ran on unreachable.
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  const now = Date.parse("2026-10-31T04:00:00Z");
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const sessions = [
    { id: "lost-working", mode: "chat", status: "working", statusReadiness: "unavailable", activity: { lastActivityAt: ago(40) } },
    { id: "lost-idle", mode: "chat", status: "idle", statusReadiness: "unavailable", activity: { lastActivityAt: ago(40) } },
    { id: "lost-recent", mode: "chat", status: "working", statusReadiness: "unavailable", activity: { lastActivityAt: ago(10) } },
    { id: "checking", mode: "chat", status: "working", statusReadiness: "checking", activity: { lastActivityAt: ago(40) } },
    { id: "busy", mode: "chat", status: "working", statusReadiness: "ready", activity: { lastActivityAt: ago(40) } },
    { id: "stale", mode: "chat", status: "working", statusReadiness: "ready", activity: { lastActivityAt: ago(150) } },
  ];
  const posts = [];
  let readiness = "unavailable";
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, Date, Math, Number, Promise, agentTools: null,
    exitedReleased: new Set(), logger: null, setTimeout: (resolve) => { resolve(); return 0; },
    internalApi: async (method, endpoint) => {
      if (endpoint === "/api/v1/sessions") return { sessions };
      if (method === "POST") posts.push(endpoint.split("/").at(-1));
      if (endpoint.endsWith("/resume-agent")) { readiness = "ready"; return { ok: true }; }
      return { session: { id: endpoint.split("/")[4], mode: "chat", status: "working", statusReadiness: readiness, activity: { state: "active" } } };
    },
  });
  assert.equal(await upstream.continuable("lost-working"), true);
  assert.deepEqual(posts, ["resume-agent"], "AO is asked to reconnect it before the message is sent");
  posts.length = 0;
  assert.equal(await upstream.continuable("lost-working"), true);
  assert.deepEqual(posts, [], "a chat AO has its controller for is sent to as before");
  assert.deepEqual([...await upstream.quietWorkingChatSessions(2 * 60 * 60_000, now, 30 * 60_000)].sort(), ["lost-idle", "lost-working", "stale"],
    "one AO lost is released after the shorter limit; a recent, still-checking or live working one is kept");
  assert.deepEqual([...await upstream.quietWorkingChatSessions(2 * 60 * 60_000, now)].sort(), ["stale"], "without the shorter limit, as before");
});

test("stale sessions are this project's live, unpinned, idle ones with no message (or creation) within the limit", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  const now = Date.parse("2026-10-22T10:00:00Z");
  const daysAgo = days => new Date(now - days * 86_400_000).toISOString();
  const sessions = [
    { id: "old-worker", projectId: "proj", status: "exited", createdAt: daysAgo(12) },
    { id: "old-chat-written-to", projectId: "proj", status: "idle", createdAt: daysAgo(20), lastUserMessageAt: daysAgo(2) },
    { id: "new-worker", projectId: "proj", status: "exited", createdAt: daysAgo(3) },
    { id: "old-working", projectId: "proj", status: "working", createdAt: daysAgo(12) },
    { id: "old-pinned", projectId: "proj", status: "exited", createdAt: daysAgo(12), isPinned: true },
    { id: "old-terminated", projectId: "proj", status: "terminated", createdAt: daysAgo(12), isTerminated: true },
    { id: "other-project", projectId: "elsewhere", status: "exited", createdAt: daysAgo(12) },
    { id: "no-times", projectId: "proj", status: "exited" },
  ];
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, Date, Math, Number, Promise, Set, agentTools: null,
    exitedReleased: new Set(),
    projectFor: async workspaceId => { if (workspaceId === "ws") return "proj"; throw new Error("not a git repository"); },
    internalApi: async (method, endpoint) => {
      assert.deepEqual([method, endpoint], ["GET", "/api/v1/sessions"]);
      return { sessions };
    },
  });
  assert.deepEqual([...await upstream.staleSessions(["ws", "not-bound"], 7 * 86_400_000, now)], ["old-worker"]);
  assert.deepEqual([...await upstream.staleSessions(["not-bound"], 7 * 86_400_000, now)], [], "no bound project, nothing listed");
});

test("a resumed chat gets the app's tools again, and an AO that refuses them still resumes it", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  const bodies = [];
  let refuseServers = false;
  let status = "exited";
  const servers = [{ name: "coding-tools", type: "http", url: "http://127.0.0.1:1/mcp/ws/k", headers: { Authorization: "Bearer fixture" } }];
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, Date, Math, Number, Promise,
    agentTools: { renew: async id => id === "chat-1" ? { servers } : null },
    internalApi: async (method, endpoint, body) => {
      if (endpoint.endsWith("/resume-agent")) {
        bodies.push(JSON.parse(JSON.stringify(body)));
        if (refuseServers && body?.mcpServers) throw new Error("unknown field mcpServers");
        status = "idle";
        return { ok: true };
      }
      return { session: { id: endpoint.split("/")[4], mode: "chat", status } };
    },
  });
  assert.equal(await upstream.continuable("chat-1"), true);
  assert.deepEqual(bodies, [{ mcpServers: servers }], "the resume carries the session's fresh tool servers");
  status = "exited"; refuseServers = true; bodies.length = 0;
  assert.equal(await upstream.continuable("chat-1"), true, "an older AO that refuses the field still resumes the chat");
  assert.deepEqual(bodies, [{ mcpServers: servers }, {}]);
  status = "exited"; bodies.length = 0;
  assert.equal(await upstream.continuable("chat-2"), true);
  assert.deepEqual(bodies, [{}], "a session that never had the app's tools resumes as before");
});

test("a resumed chat gets the person's own MCP servers after the app's, for its own agent", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  const bodies = [], asked = [];
  let status = "exited", broken = false;
  const app = { name: "coding-tools", type: "http", url: "http://127.0.0.1:1/mcp/ws/k", headers: { Authorization: "Bearer fixture" } };
  const mine = { name: "notes", type: "stdio", command: "notes-mcp" };
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), Date, Math, Number, Promise, logger: { warn() {}, info() {} },
    agentTools: { renew: async id => id === "chat-1" ? { servers: [app] } : null },
    userMcpServers: { forSession: (agent, taken) => { asked.push([agent, JSON.parse(JSON.stringify(taken.map(server => server.name)))]); if (broken) throw new Error("unreadable"); return [mine]; } },
    internalApi: async (method, endpoint, body) => {
      if (endpoint.endsWith("/resume-agent")) { bodies.push(JSON.parse(JSON.stringify(body))); status = "idle"; return { ok: true }; }
      return { session: { id: endpoint.split("/")[4], mode: "chat", harness: "opencode", status } };
    },
  });
  assert.equal(await upstream.continuable("chat-1"), true);
  assert.deepEqual(bodies, [{ mcpServers: [app, mine] }]);
  assert.deepEqual(asked, [["opencode", ["coding-tools"]]], "asked for the session's own agent, after the app's server");
  status = "exited"; bodies.length = 0;
  assert.equal(await upstream.continuable("chat-2"), true);
  assert.deepEqual(bodies, [{ mcpServers: [mine] }], "a chat without the app's tools still gets them");
  status = "exited"; bodies.length = 0; broken = true;
  assert.equal(await upstream.continuable("chat-2"), true, "an unreadable list never fails the resume");
  assert.deepEqual(bodies, [{}]);
});

test("reopening a released chat and sending at once resumes its agent once, and the send continues it", async () => {
  // The chat's pre-warm (600 ms after it opens) and its send both ask continuable() while the
  // agent released while idle comes back. The second asked mid-resume: AO refused a second resume,
  // and the send started a fresh session beside the one coming back.
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  let status = "exited", resuming = false, resumes = 0, renewals = 0;
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, Date, Math, Number, Promise,
    agentTools: { renew: async () => { renewals += 1; return null; } },
    internalApi: async (method, endpoint) => {
      if (endpoint.endsWith("/resume-agent")) {
        resumes += 1;
        if (resuming) throw new Error("The session's agent is already starting (SESSION_BUSY)");
        resuming = true;
        await new Promise(resolve => setTimeout(resolve, 30));
        resuming = false; status = "idle";
        return { ok: true };
      }
      return { session: { id: endpoint.split("/")[4], mode: "chat", status } };
    },
  });
  const [prewarm, send] = await Promise.all([upstream.continuable("chat-1"), upstream.continuable("chat-1")]);
  assert.equal(prewarm, true);
  assert.equal(send, true, "the send continues the chat's own agent");
  assert.equal(resumes, 1, "one resume");
  assert.equal(renewals, 1, "one fresh credential for it");
  status = "exited";
  assert.equal(await upstream.continuable("chat-1"), true, "asked again later, it is checked again");
  assert.equal(resumes, 2);
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

test("a question the agent asks (AskUserQuestion) waits in the chat with its options, and the answer goes back to AO", async () => {
  const posted = [];
  const upstream = observeHarness({
    internalApi: async (method, endpoint, body) => {
      if (method === "POST") { posted.push([endpoint, body]); return {}; }
      return endpoint.includes("/conversation") ? {
        turns: [{ id: "t", state: "running" }], messages: [],
        activities: [{ id: "q1", turnId: "t", sequence: 3, activityKind: "user_input", status: "pending", requestId: "req-q",
          summary: "Please answer the following questions.", createdAt: "2026-10-13T14:23:00Z",
          detail: { inputMode: "form", message: "Please answer the following questions.", schema: { type: "object", properties: {
            question_0: { type: "string", title: "Lockfile", description: "Rewrite the lockfile hosts or regenerate it?",
              oneOf: [{ const: "Rewrite hosts", title: "Rewrite hosts", description: "Keep every pinned version" }, { const: "Regenerate", title: "Regenerate" }] },
            question_0_custom: { type: "string", title: "Other" },
            question_1: { type: "array", title: "Backend", items: { anyOf: [{ const: "fastapi", title: "fastapi" }, { const: "uvicorn", title: "uvicorn" }] } },
          } } } },
        { id: "q0", turnId: "t", sequence: 2, activityKind: "user_input", status: "resolved", requestId: "req-old", detail: {} }],
      } : { session: { id: "s", mode: "chat", status: "needs_input" } };
    },
  });
  const approvals = JSON.parse(JSON.stringify((await upstream.observe("s")).approvals));
  assert.equal(approvals.length, 1, "only the pending one");
  const [question] = approvals;
  assert.equal(question.kind, "question");
  assert.equal(question.approval_id, "req-q");
  assert.equal(question.message, "Please answer the following questions.");
  assert.deepEqual(question.fields.map((field) => [field.key, field.type, field.customKey ?? null]),
    [["question_0", "choice", "question_0_custom"], ["question_1", "multi", null]], "the Other field belongs to its question, not a question of its own");
  assert.deepEqual(question.fields[0].options.map((option) => option.label), ["Rewrite hosts", "Regenerate"]);
  assert.equal(question.fields[0].options[0].description, "Keep every pinned version");
  await upstream.resolveInput("s", "req-q", "accept", { question_0: "Rewrite hosts", question_1: ["fastapi"] });
  await upstream.resolveInput("s", "req-q", "decline", { ignored: true });
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
    ["/api/v1/sessions/s/conversation/inputs/req-q/resolve", { action: "accept", content: { question_0: "Rewrite hosts", question_1: ["fastapi"] } }],
    ["/api/v1/sessions/s/conversation/inputs/req-q/resolve", { action: "decline" }],
  ]);
  await assert.rejects(upstream.resolveInput("s", "req-q", "allow"), /Answer, decline or cancel/);
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

test("observes of one session that overlap share one conversation read; later ones read again", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      reads += 1;
      await gate;
      return { turns: [{ id: "t", state: "running" }], messages: [{ id: "m", turnId: "t", sequence: 1, role: "assistant", text: `read ${reads}` }], activities: [] };
    },
  });
  // The run loop, the activity poll and the approvals poll asking at the same moment.
  const together = Promise.all([upstream.observe("s"), upstream.observe("s"), upstream.observe("s")]);
  await new Promise(setImmediate);
  release();
  const observed = await together;
  assert.equal(reads, 1, "one read served all three");
  assert.deepEqual([...observed.map((entry) => entry.liveOutput)], ["read 1", "read 1", "read 1"]);
  await upstream.observe("s");
  assert.equal(reads, 2, "a landed read is never reused: the next observe reads afresh");
});

test("a chat whose newest items are each over the handler limit still shows its work, with their big fields cut", async () => {
  // Seen live: two screenshot tool calls of 1.3 MB each among a chat's newest 20 items made every
  // conversation read 2.7 MB; all sizes failed, and the chat showed nothing for 5 hours.
  const screenshot = "data:image/png;base64," + "A".repeat(1_300_000);
  const asked = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint, _body, options) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      asked.push(options?.maxBytes ?? null);
      if (!options?.maxBytes) throw new Error("AO response exceeds the handler limit (GET /api/v1/sessions/s/conversation)");
      return {
        turns: [{ id: "t", state: "running" }],
        messages: [{ id: "m", turnId: "t", sequence: 2, role: "assistant", text: "Took a screenshot of the game." }],
        activities: [{ id: "shot", turnId: "t", sequence: 1, activityKind: "mcp_tool", status: "completed", summary: "capture_screenshot",
          detail: { toolName: "mcp__coding-tools__capture_screenshot", output: "Captured 1920x1080.", content: [{ type: "image", data: screenshot }] } }],
      };
    },
  });
  const observed = await upstream.observe("s");
  assert.ok(asked.slice(0, -1).every((value) => value === null), "the usual sizes are tried first");
  assert.ok(asked.at(-1) > 2_000_000, "then one read with room for the big items");
  const timeline = JSON.parse(JSON.stringify(observed.timeline));
  assert.deepEqual(timeline.map((item) => item.id), ["shot", "m"], "the turn's work shows again");
  assert.equal(timeline[0].output, "Captured 1920x1080.", "the tool's text output is kept");
  assert.ok(JSON.stringify(observed).length < 100_000, "the image bytes are not carried along");
});

test("cutting a big page keeps an edit's source text, so a change deep in a large file still shows", async () => {
  const lines = Array.from({ length: 4000 }, (_, at) => `line ${at} of a large file`);
  const before = [...lines, "old tail"].join("\n"), after = [...lines, "new tail"].join("\n");
  const upstream = observeHarness({
    internalApi: async (_method, endpoint, _body, options) => {
      if (!endpoint.includes("/conversation")) return { session: { id: "s", mode: "chat", status: "working" } };
      if (!options?.maxBytes) throw new Error("AO response exceeds the handler limit (GET /api/v1/sessions/s/conversation)");
      return {
        turns: [{ id: "t", state: "running" }], messages: [],
        activities: [
          { id: "shot", turnId: "t", sequence: 1, activityKind: "mcp_tool", status: "completed", summary: "capture_screenshot",
            detail: { output: "Captured.", content: [{ type: "image", data: "A".repeat(1_300_000) }] } },
          // An ACP edit: its counts and diff are computed from the whole file before and after.
          { id: "edit", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "Edit",
            detail: { toolName: "Edit", toolKind: "edit", content: [{ type: "diff", path: "C:\\app\\big.txt", oldText: before, newText: after }] } },
        ],
      };
    },
  });
  const edit = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline)).find((item) => item.id === "edit");
  assert.equal(edit.files[0].additions, 1, "the changed last line is counted");
  assert.equal(edit.files[0].deletions, 1);
  assert.match(edit.files[0].diff, /-old tail\n\+new tail/);
});

test("an ACP edit opens on its changed lines, not the whole file, and a long message is not cut at 4 KB", async () => {
  // As AO stored it live: the whole file before and after, and a patch marking every line changed.
  const lines = Array.from({ length: 200 }, (_, at) => `line ${at}`);
  const before = lines.join("\r\n"), after = before.replace("line 100", "changed 100");
  const answer = `${"word ".repeat(1200)}\`_complete_oauth_in_page\` returns None.`;
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }],
      messages: [{ id: "m", turnId: "t", sequence: 2, role: "assistant", text: answer }],
      activities: [{ id: "e", turnId: "t", sequence: 1, activityKind: "file_change", status: "completed", summary: "Edit",
        detail: { files: [{ path: "C:\\app\\Accounts.tsx", status: "modified", additions: 1, deletions: 1, oldText: before, newText: after,
          patch: ["--- C:\\app\\Accounts.tsx", "+++ C:\\app\\Accounts.tsx", ...lines.map(line => `-${line}`), ...lines.map(line => `+${line}`)].join("\n") }] } }],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const [edit, message] = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.equal(edit.kind, "edit");
  assert.equal(edit.files[0].diff, ["@@ -98,7 +98,7 @@", " line 97", " line 98", " line 99", "-line 100", "+changed 100",
    " line 101", " line 102", " line 103"].join("\n"), "one numbered hunk with 3 context lines, as Claude Code shows it");
  assert.equal(message.text, answer, "the whole answer, its closing code span included");
});

test("live text past 4 KB keeps moving: the streaming answer stays whole and running reasoning keeps its newest part", async () => {
  const answer = `Start of the answer.\n${"a".repeat(9000)}\nEnd so far.`;
  const thought = `First thought.\n${"t".repeat(9000)}\nNewest thought: checking lifecycle.py`;
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }],
      messages: [{ id: "m", turnId: "t", sequence: 2, role: "assistant", streaming: true, text: answer }],
      activities: [
        { id: "r1", turnId: "t", sequence: 1, activityKind: "reasoning", status: "running", summary: "Reasoning", detail: { text: thought } },
        { id: "r0", turnId: "t", sequence: 0, activityKind: "reasoning", status: "completed", summary: "Reasoning", detail: { text: thought } },
      ],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const items = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  const byId = Object.fromEntries(items.map(item => [item.id, item]));
  assert.equal(byId.m.text, answer.trim(), "the streaming answer is not frozen at 4 KB");
  assert.ok(byId.r1.text.endsWith("Newest thought: checking lifecycle.py"), "running reasoning keeps its newest part");
  assert.ok(Buffer.byteLength(byId.r1.text) <= 4096);
  assert.equal(byId.r0.text, thought, "finished reasoning is kept whole (up to 64 KB), its opening heading the folded row");
});

test("a tool call carries its description, arguments and output, so its row can open on them as Claude Code's do", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation") ? {
      turns: [{ id: "t", state: "running" }], messages: [],
      activities: [
        { id: "1", turnId: "t", sequence: 1, activityKind: "mcp_tool", status: "failed", summary: "PowerShell",
          detail: { toolKind: "other", providerToolName: "PowerShell", input: { command: "npm config list", description: "Inspect npm registry configuration" },
            output: "User refused permission to run tool" } },
        { id: "2", turnId: "t", sequence: 2, activityKind: "mcp_tool", status: "completed", summary: "mcp__coding-tools__read_file",
          detail: { toolKind: "other", providerToolName: "mcp__coding-tools__read_file", input: { path: "main.py", limit: 40 },
            output: "", content: [{ type: "content", content: { type: "text", text: "from fastapi import FastAPI" } }] } },
        { id: "3", turnId: "t", sequence: 3, activityKind: "mcp_tool", status: "pending", summary: "Read x", detail: { toolKind: "read", input: {} } },
      ],
    } : { session: { id: "s", mode: "chat", status: "working" } },
  });
  const [shell, read, waiting] = JSON.parse(JSON.stringify((await upstream.observe("s")).timeline));
  assert.equal(shell.kind, "command");
  assert.equal(shell.status, "failed");
  assert.equal(shell.description, "Inspect npm registry configuration");
  assert.equal(shell.input, undefined, "the command and description are shown already, not again as arguments");
  assert.equal(shell.output, "User refused permission to run tool");
  assert.equal(read.label, "MCP", "AO names the tool providerToolName");
  assert.deepEqual(JSON.parse(read.input), { path: "main.py", limit: 40 });
  assert.equal(read.output, "from fastapi import FastAPI", "the ACP content blocks when there is no plain output");
  assert.equal(waiting.input, undefined);
  assert.equal(waiting.output, undefined);
});

test("a finished turn's work is read back from AO, paging back until it reaches the turn before", async () => {
  const requests = [];
  const page = (entries, oldest, more) => ({ turns: [], messages: [], activities: entries, oldestSequence: oldest, hasMoreBefore: more });
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      requests.push(endpoint);
      if (!endpoint.includes("beforeSequence")) {
        return page([{ id: "9", turnId: "later", sequence: 90, activityKind: "mcp_tool", status: "completed", summary: "Edit", detail: { toolKind: "edit", input: {} } },
          { id: "5", turnId: "mine", sequence: 50, activityKind: "reasoning", status: "completed", detail: { text: "Checking the route" } }], 50, true);
      }
      if (endpoint.includes("beforeSequence=50")) {
        return page([{ id: "4", turnId: "mine", sequence: 40, activityKind: "mcp_tool", status: "completed", summary: "PowerShell", detail: { toolKind: "other", input: { command: "ls" } } }], 40, true);
      }
      return page([{ id: "1", turnId: "earlier", sequence: 10, activityKind: "mcp_tool", status: "completed", summary: "Read a", detail: { toolKind: "read", input: {} } },
        { id: "3", turnId: "mine", sequence: 30, activityKind: "mcp_tool", status: "completed", summary: "Read b", detail: { toolKind: "read", input: {} } }], 10, true);
    },
  });
  const items = JSON.parse(JSON.stringify(await upstream.timeline("s", "mine")));
  assert.deepEqual(items.map(item => item.id), ["3", "4", "5"], "only this turn's items, oldest first, across three pages");
  assert.equal(requests.filter(endpoint => endpoint.includes("beforeSequence")).length, 2, "it stops once a page reaches the turn before");
  assert.equal((await upstream.timeline("s", "")).length, 0, "no turn, nothing to read");
});

test("finished turns opened together are read back a few at a time, and a turn asked twice is read once", async () => {
  // Seen live on 0.8.29: opening a chat read back every finished card at once, each paging through
  // AO, and the burst filled the headless service's 16 request slots ("admission is full").
  let inFlight = 0, most = 0;
  const asked = [];
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      asked.push(endpoint);
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      const session = /sessions\/([^/]+)\//.exec(endpoint)[1];
      return { turns: [], messages: [], hasMoreBefore: false, oldestSequence: 1,
        activities: [{ id: `${session}-1`, turnId: "t", sequence: 1, activityKind: "reasoning", status: "completed", detail: { text: "done" } }] };
    },
  });
  const sessions = Array.from({ length: 20 }, (_, index) => `s${index}`);
  const reads = await Promise.all([...sessions, "s0"].map(id => upstream.timeline(id, "t")));
  assert.ok(most <= 3, `at most three reads at once (saw ${most})`);
  assert.deepEqual(reads.map(items => items[0]?.id), [...sessions, "s0"].map(id => `${id}-1`), "every turn is read back");
  assert.equal(asked.filter(endpoint => endpoint.includes("/sessions/s0/")).length, 1, "the same turn asked twice shares one read");
  assert.equal((await upstream.timeline("s0", "t"))[0].id, "s0-1", "a later ask reads it again");
});

test("a finished turn's read waits out a full service instead of failing with every card queued behind it", async () => {
  // Seen live on 0.8.30's first start: the chat polls filled the headless service, one chat's shared
  // tail read was turned away, and all 23 of its cards failed inside 10 ms with empty Worked rows.
  let refusals = 2;
  const waits = [];
  const upstream = observeHarness({
    setTimeout: (callback, ms) => { waits.push(ms); setImmediate(callback); },
    internalApi: async () => {
      if (refusals > 0) { refusals -= 1; throw new Error("HEADLESS_CAPACITY: request admission is full"); }
      return { turns: [], messages: [], hasMoreBefore: false, oldestSequence: 1,
        activities: [{ id: "a1", turnId: "t", sequence: 1, activityKind: "reasoning", status: "completed", detail: { text: "done" } }] };
    },
  });
  const reads = await Promise.all(["t", "t"].map(turn => upstream.timeline("s", turn)));
  assert.deepEqual(reads.map(items => items[0]?.id), ["a1", "a1"], "the read lands once the service has room");
  assert.deepEqual(waits.slice(0, 2), [1000, 2000], "it backs off between tries");
  // Any other failure is not waited out.
  const failing = observeHarness({
    setTimeout: (callback, ms) => { waits.push(ms); setImmediate(callback); },
    internalApi: async () => { throw new Error("CHAT_SESSION_NOT_FOUND"); },
  });
  waits.length = 0;
  await assert.rejects(failing.timeline("s", "t"), /CHAT_SESSION_NOT_FOUND/);
  assert.deepEqual(waits, []);
});

test("a redact_message row shows its label and a count, never the secrets it hid", async () => {
  // Codex review of #653: the blurred key stayed readable in the tool row under Worked.
  const upstream = observeHarness({
    internalApi: async () => ({ turns: [], messages: [], hasMoreBefore: false, oldestSequence: 1, activities: [{
      id: "a1", turnId: "t", sequence: 1, activityKind: "mcp_tool", status: "completed",
      summary: "mcp__coding-tools__redact_message sk-live-0123456789abcdef",
      detail: { toolName: "mcp__coding-tools__redact_message", input: { secrets: ["sk-live-0123456789abcdef", "hunter2!x"], label: "API key" },
        output: "Hid 2 occurrences in the user's messages." } }] }),
  });
  const [row] = await upstream.timeline("s", "t");
  const shown = JSON.stringify(row);
  assert.doesNotMatch(shown, /sk-live-0123456789abcdef|hunter2!x/);
  assert.match(row.input, /"label": "API key"/);
  assert.match(row.input, /2 hidden \(not shown\)/);
});

test("a long finished turn keeps its tool calls when a page is over AO's handler limit, past six pages", async () => {
  // Seen live: a 20-minute turn opened on only its last thought. Paging back stopped at the first
  // page over the 900 KB handler limit (a command's long output), and after six pages in any case.
  const requests = [];
  const tool = (sequence) => ({ id: `t${sequence}`, turnId: "mine", sequence, activityKind: "mcp_tool", status: "completed",
    summary: `Step ${sequence}`, detail: { toolKind: "other", input: { command: `step ${sequence}` } } });
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => {
      requests.push(endpoint);
      const before = Number(/beforeSequence=(\d+)/.exec(endpoint)?.[1] ?? 1000);
      const limit = Number(/limit=(\d+)/.exec(endpoint)[1]);
      // Sequence 900's output is over the limit on its own; pages near it are over it at 60.
      if (before > 900 && before - limit <= 900) throw new Error("AO response exceeds the handler limit (GET /conversation)");
      if (before > 850 && before <= 960 && limit === 60) throw new Error("AO response exceeds the handler limit (GET /conversation)");
      const sequences = [];
      for (let sequence = before - 1; sequence >= Math.max(1, before - limit); sequence -= 1) sequences.push(sequence);
      const activities = sequences.map(sequence => sequence < 100 ? { ...tool(sequence), turnId: "earlier" } : tool(sequence));
      return { turns: [], messages: [], activities, oldestSequence: Math.min(...sequences), hasMoreBefore: Math.min(...sequences) > 1 };
    },
  });
  const items = await upstream.timeline("s", "mine");
  const ids = items.map(item => item.id);
  assert.equal(ids.includes("t901"), true, "the items around the oversized one are still read");
  assert.equal(ids.includes("t899"), true);
  assert.equal(ids.includes("t900"), false, "the one item over the limit on its own is stepped past");
  assert.equal(items.length, 400, "a turn longer than the chat keeps is read back to TIMELINE_ITEMS of its newest items");
  assert.equal(ids.at(-1), "t999");
  assert.ok(requests.filter(endpoint => endpoint.includes("beforeSequence")).length > 6, "more than six pages back");
  assert.ok(requests.some(endpoint => /limit=20&beforeSequence/.test(endpoint)), "an oversized page is read again smaller");
});

for (const method of ["interrupt", "exitAgent", "kill"]) {
  test(method + " cancels pending tool calls before contacting AO without revoking the retained lease", async () => {
    const calls = [];
    const upstream = observeHarness({
      agentTools: { cancelSessionCalls: id => { calls.push(["cancel-pending", id]); },
        forgetSession: id => { calls.push(["forget", id]); } },
      internalApi: async (verb, endpoint) => { calls.push([verb, endpoint]); throw new Error("fixture transport unavailable"); },
    });
    await assert.rejects(upstream[method]("s"), /fixture transport unavailable/);
    assert.deepEqual(calls.slice(0, 1), [["cancel-pending", "s"]], "pending approvals expire before the stop request awaits transport");
    assert.equal(calls.some(([kind]) => kind === "forget"), false, "an unconfirmed stop keeps the resumable credential");
  });
}

test("interrupt propagates transport, status-read, kill and retry failures", async () => {
  for (const stage of ["transport", "status", "kill", "retry"]) {
    let interrupts = 0, forgotten = 0;
    const upstream = observeHarness({
      agentTools: { forgetSession: () => { forgotten++; } },
      internalApi: async (_method, endpoint) => {
        if (endpoint.endsWith("/interrupt")) {
          interrupts++;
          if (stage === "transport" || interrupts > 1) throw new Error("temporary transport failure");
          throw new Error("CHAT_CONTROLLER_NOT_READY");
        }
        if (endpoint.endsWith("/kill")) throw new Error("temporary kill failure");
        if (stage === "status") throw new Error("temporary status failure");
        return { session: { provisionState: stage === "kill" ? "provisioning" : "ready" } };
      },
    });
    await assert.rejects(upstream.interrupt("s"), /temporary/, stage);
    assert.equal(forgotten, 0, "do not revoke tools while cancellation is unconfirmed");
  }
});

test("interrupt is idempotent for an ended turn and cancels a queued start only after the kill is acknowledged", async () => {
  let forgotten = 0;
  const calls = [];
  const ended = observeHarness({ internalApi: async () => { throw new Error("CHAT_NO_ACTIVE_TURN"); } });
  await ended.interrupt("s");
  const queued = observeHarness({
    agentTools: { forgetSession: id => { assert.equal(id, "s"); forgotten++; } },
    internalApi: async (method, endpoint) => {
      calls.push([method, endpoint]);
      if (endpoint.endsWith("/interrupt")) throw new Error("CHAT_CONTROLLER_NOT_READY");
      if (method === "GET") return { session: { provisionState: "provisioning" } };
      return { ok: true };
    },
  });
  await queued.interrupt("s");
  assert.equal(forgotten, 1);
  assert.deepEqual(calls.map(([, endpoint]) => endpoint), [
    "/api/v1/sessions/s/conversation/interrupt", "/api/v1/sessions/s", "/api/v1/sessions/s/kill",
  ]);
});

test("interrupting a session whose agent process exited has nothing to stop, and never throws the refusal", async () => {
  // Seen live: Stop and steer on a MiMo chat whose agent had died showed "the agent controller for
  // this session is not running" and never finished.
  const calls = [];
  const dead = observeHarness({
    internalApi: async (method, endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith("/interrupt")) throw new Error("CHAT_CONTROLLER_NOT_READY");
      return { session: { provisionState: "ready" } };
    },
  });
  await dead.interrupt("s");
  assert.equal(calls.filter(endpoint => endpoint.endsWith("/kill")).length, 0, "a session that is not starting is never killed");
});

test("a running turn with no agent process behind it is over: interrupted, with the last provider failure as the reason", async () => {
  const upstream = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation?limit=100&includePending=1") ? {
      controller: "stopped", turns: [{ id: "t", state: "running" }], messages: [],
      activities: [{ id: "r1", turnId: "t", sequence: 2, activityKind: "system", status: "running", summary: "Retrying Claude, attempt 10 of 10.",
        detail: { event: "provider.failure", text: "API error 429. Trying again in 30s." } }],
    } : endpoint.endsWith("/conversation/interrupt") ? Promise.reject(new Error("CHAT_CONTROLLER_NOT_READY"))
      : { session: { id: "s", mode: "chat", status: "working", provisionState: "ready" } },
  });
  const seen = await upstream.observe("s");
  assert.equal(seen.turnState, "interrupted", "the card can retry instead of sitting on 'may be stuck'");
  assert.equal(seen.agentGone, true);
  assert.match(seen.error, /process stopped mid-turn after: API error 429/);
  const starting = observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation?limit=100&includePending=1")
      ? { controller: "stopped", turns: [{ id: "t", state: "running" }], messages: [], activities: [] }
      : { session: { id: "s", mode: "chat", status: "working", provisionState: "provisioning" } },
  });
  const coming = await starting.observe("s");
  assert.equal(coming.turnState, "running", "an agent still starting has no controller yet, and is not gone");
  assert.equal(coming.agentGone, undefined);
});

test("a running turn whose controller stopped while its chat host is still up keeps running", async () => {
  // Seen live 2026-10-31: at an app quit AO dropped every controller, and three cards read "stopped
  // mid-turn" and were retried while two of the turns ran on in their hosts, so each chat got a
  // needless "you were interrupted" turn queued behind its own.
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ct-ao-host-up-"));
  const live = require("node:net").createServer().listen(0, "127.0.0.1");
  await new Promise(resolve => live.once("listening", resolve));
  const hostFile = path.join(dataRoot, "chat-hosts", "s", "host.json");
  fs.mkdirSync(path.dirname(hostFile), { recursive: true });
  fs.writeFileSync(hostFile, JSON.stringify({ address: `127.0.0.1:${live.address().port}`, pid: 1 }));
  const interrupts = [];
  const upstream = observeHarness({ dataRoot,
    internalApi: async (_method, endpoint) => {
      if (endpoint.includes("/conversation?limit=100&includePending=1")) return { controller: "stopped", turns: [{ id: "t", state: "running" }], messages: [], activities: [] };
      if (endpoint.endsWith("/interrupt")) { interrupts.push(endpoint); return {}; }
      return { session: { id: "s", mode: "chat", status: "working", provisionState: "ready" } };
    },
  });
  try {
    const kept = await upstream.observe("s");
    assert.equal(kept.turnState, "running", "the host still runs the agent: the next AO reattaches it");
    assert.equal(kept.error, undefined, "the card is not failed");
    assert.deepEqual(interrupts, [], "nothing is interrupted");
    // An agent that exits takes its host with it, and the host deletes its record.
    fs.rmSync(hostFile);
    const ended = await upstream.observe("s");
    assert.equal(ended.turnState, "interrupted");
    assert.equal(ended.agentGone, true);
  } finally {
    live.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a request left pending by an agent that is gone shows no card, since nothing can take the answer", async () => {
  // Seen live 2026-10-23: Allow on such a card failed twice with "the agent controller for this
  // session is not running (CHAT_CONTROLLER_NOT_READY)".
  const approval = { id: "a1", turnId: "t", sequence: 2, activityKind: "approval", status: "pending", requestId: "req-1",
    summary: "Bash", detail: { toolName: "Bash", input: { command: "git status" }, decisions: [{ id: "allow", kind: "allow_once", label: "Allow" }] } };
  const read = (controller) => observeHarness({
    internalApi: async (_method, endpoint) => endpoint.includes("/conversation?limit=100&includePending=1")
      ? { controller, turns: [{ id: "t", state: "completed" }], messages: [], activities: [approval] }
      : { session: { id: "s", mode: "chat", status: "working", provisionState: "ready" } },
  }).observe("s");
  const gone = await read("stopped");
  assert.equal(gone.agentGone, true);
  assert.equal(gone.approvals.length, 0);
  const live = await read("running");
  assert.equal(live.approvals.map(item => item.approval_id).join(","), "req-1", "a live agent's request still shows");
});

test("a send binds its workspace in AO once, not for every catalog read and the launch", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  async function projectFor");
  const end = source.indexOf("  async function chatTools", start);
  assert.ok(start >= 0 && end > start, "project binding helpers are present");
  const block = source.slice(start, end);
  const binds = [];
  let failing = false;
  const upstream = vm.runInNewContext(block + "({ projectFor, forgetProject })", {
    Date, Map, Promise,
    workspaceBoard: { bind: async id => {
      binds.push(id);
      if (failing) throw new Error("git is busy");
      return { workspaceId: id, projectId: id === "plain-folder" ? null : `project-${id}` };
    } },
  });
  assert.equal(await upstream.projectFor("ws-1"), "project-ws-1");
  assert.equal(await upstream.projectFor("ws-1"), "project-ws-1");
  assert.deepEqual(binds, ["ws-1"], "the launch reuses the binding its model check just made");
  upstream.forgetProject("ws-1");
  await upstream.projectFor("ws-1");
  assert.equal(binds.length, 2, "a failed start (or a new daemon) binds again");
  await assert.rejects(upstream.projectFor("plain-folder"), /git repository registered in AO/);
  await assert.rejects(upstream.projectFor("plain-folder"));
  assert.equal(binds.filter(id => id === "plain-folder").length, 2, "a workspace without a project is not kept");
  failing = true;
  await assert.rejects(upstream.projectFor("ws-2"), /git is busy/);
  failing = false;
  assert.equal(await upstream.projectFor("ws-2"), "project-ws-2", "a failed binding is not kept");
});

test("the context meter keeps its reading through a steer's zero snapshot, and drops on a compaction", () => {
  const { steadyContext } = require("../electron/agent-orchestrator-upstream.cjs");
  const readings = new Map();
  const at = (contextUsed, compactedAt = null) => steadyContext(readings, "s1", { contextUsed, contextWindow: 200000, totalTokens: 9 }, compactedAt);
  assert.equal(at(120000).contextUsed, 120000);
  const steered = at(0);
  assert.equal(steered.contextUsed, 120000, "a steer's interrupted request reports 0 input: the last reading stands");
  assert.equal(steered.totalTokens, 9, "the rest of the report still comes through");
  assert.equal(at(20000).contextUsed, 120000, "a fall below a quarter with no compaction is the same snapshot");
  assert.equal(at(130000).contextUsed, 130000, "growth is read as reported");
  assert.equal(at(90000).contextUsed, 90000, "a smaller drop is real (a tool result trimmed)");
  assert.equal(at(5000, "2026-10-19T12:00:00Z").contextUsed, 5000, "a compaction really empties it");
  assert.equal(steadyContext(readings, "s2", { contextUsed: 0, contextWindow: 200000 }, null).contextUsed, 0, "another session starts on its own");
  // Seen live: after a steer the panel read In 0 · Out 0 · Cached 0 · Total 0 beside a $6.40 cost.
  steadyContext(readings, "s3", { contextUsed: 300000, contextWindow: 400000, inputTokens: 13_000_000, outputTokens: 100_000, cachedTokens: 12_000_000, totalTokens: 13_100_000, cost: 6.4 }, null);
  const snapshot = steadyContext(readings, "s3", { contextUsed: 0, contextWindow: 400000, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 6.41 }, null);
  assert.deepEqual([snapshot.contextUsed, snapshot.inputTokens, snapshot.outputTokens, snapshot.cachedTokens, snapshot.totalTokens, snapshot.cost],
    [300000, 13_000_000, 100_000, 12_000_000, 13_100_000, 6.41], "the zeroed counts keep the last reading's; what it does report (cost) comes through");
  // Seen live: 43% and 171.9k of context beside In 0 · Out 0 · Cached 0 · Total 0. The context
  // reading held (no steer drop), but an ACP prompt's own zero usage replaced the running totals.
  steadyContext(readings, "s4", { contextUsed: 171_900, contextWindow: 400000, inputTokens: 6_160_000, outputTokens: 70_900, cachedTokens: 6_000_000, totalTokens: 6_230_900 }, null);
  const zeroed = steadyContext(readings, "s4", { contextUsed: 172_000, contextWindow: 400000, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 }, null);
  assert.deepEqual([zeroed.contextUsed, zeroed.inputTokens, zeroed.totalTokens], [172_000, 6_160_000, 6_230_900], "the totals never go down");
  const after = steadyContext(readings, "s4", { contextUsed: 173_000, contextWindow: 400000, inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2 }, null);
  assert.equal(after.totalTokens, 6_230_900, "the held totals were saved, so a later small report does not lose them either");
  // Seen live: 362.9k that really went down to 90.2k (just under a quarter) was held at 362.9k.
  steadyContext(readings, "s5", { contextUsed: 362_936, contextWindow: 400000, totalTokens: 932_660 }, null);
  assert.equal(steadyContext(readings, "s5", { contextUsed: 90_157, contextWindow: 400000, totalTokens: 932_660 }, null).contextUsed, 90_157,
    "a real smaller context comes through");
  assert.equal(steadyContext(readings, "s5", { contextUsed: 900, contextWindow: 400000, totalTokens: 932_660 }, null).contextUsed, 90_157,
    "the near-nothing snapshot is still held");
  steadyContext(readings, "s6", { contextUsed: 400_000, contextWindow: 400000 }, null);
  assert.equal(steadyContext(readings, "s6", { contextUsed: 40_000, contextWindow: 400000 }, null).contextUsed, 40_000,
    "a large real drop below a quarter, but not near nothing, comes through");
});

test("a daemon-owned resume conflict waits for readiness and concurrent callers never send early", async () => {
  let status = "exited", resumes = 0, sends = 0, ticks = [];
  const upstream = observeHarness({
    setTimeout: callback => { ticks.push(callback); },
    internalApi: async (method, endpoint) => {
      if (method === "POST") {
        resumes++;
        throw Object.assign(new Error("The agent is already being resumed"), { status: 409, code: "AGENT_RESUME_IN_PROGRESS" });
      }
      return { session: { id: "owned", mode: "chat", status, provisionState: "ready" } };
    },
  });
  let settled = false;
  const prewarm = upstream.continuable("owned");
  const send = upstream.continuable("owned").then(ready => { if (ready) sends++; return ready; });
  const both = Promise.all([prewarm, send]).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumes, 1, "the daemon already owns restoration; do not submit another resume");
  assert.equal(settled, false, "a conflict alone cannot authorize sending");
  assert.equal(sends, 0);
  status = "idle";
  for (const tick of ticks.splice(0)) tick();
  assert.deepEqual(await both, [true, true]);
  assert.equal(sends, 1);
});

test("resume waits distinguish terminal failure from timeout and transport uncertainty", async () => {
  for (const scenario of ["terminal", "timeout", "transport"]) {
    let reads = 0, resumes = 0, clock = 0;
    const upstream = observeHarness({
      Date: { now: () => clock },
      setTimeout: callback => { clock += 1000; setImmediate(callback); },
      internalApi: async (method, endpoint) => {
        if (method === "POST") {
          // A stop while startup owns the resume is refused the same way: no second agent starts.
          if (endpoint.endsWith("/resume-agent")) resumes++;
          throw Object.assign(new Error("restoring"), { status: 409, code: "AGENT_RESUME_IN_PROGRESS" });
        }
        reads++;
        if (reads > 1 && scenario === "transport") throw new Error("read unavailable");
        return { session: { id: "owned", mode: "chat", status: reads > 1 && scenario === "terminal" ? "terminated" : "exited", provisionState: "ready" } };
      },
    });
    if (scenario === "terminal") assert.equal(await upstream.continuable("owned"), false);
    else await assert.rejects(upstream.continuable("owned"), error => error.code === "AO_SESSION_RESTORE_UNCONFIRMED");
    assert.equal(resumes, 1);
    assert.ok(reads <= 152, "readiness polling is bounded");
  }
});

test("a chat that cannot be continued says which session and why", async () => {
  // Seen 2026-10-22: "ao.continuation_lost {reason: session_gone}" and a 52 s fresh start, with no
  // way to tell which session it was or whether AO refused to restore it.
  const cases = [
    { name: "restore_refused", session: { id: "owned", mode: "chat", status: "exited", provisionState: "ready" },
      resume: Object.assign(new Error("the agent's conversation cannot be restored"), { status: 409, code: "SESSION_NOT_RESTORABLE" }),
      expect: { session: "owned", why: "restore_refused", status: "exited", provisionState: "ready", terminated: false, code: "SESSION_NOT_RESTORABLE",
        message: "the agent's conversation cannot be restored" } },
    { name: "invalid", session: { id: "owned", mode: "chat", status: "exited", provisionState: "failed" },
      expect: { session: "owned", why: "invalid", status: "exited", provisionState: "failed", terminated: false } },
    { name: "not_found", session: null, expect: { session: "owned", why: "not_found" } },
  ];
  for (const scenario of cases) {
    const logged = [];
    const upstream = observeHarness({
      logger: { info: (event, fields) => logged.push([event, fields]), warn() {} },
      internalApi: async (method) => {
        if (method === "POST") throw scenario.resume;
        if (!scenario.session) throw Object.assign(new Error("gone"), { status: 404, code: "SESSION_NOT_FOUND" });
        return { session: scenario.session };
      },
    });
    assert.equal(await upstream.continuable("owned"), false, scenario.name);
    assert.deepEqual(JSON.parse(JSON.stringify(logged)), [["ao.continuable_refused", scenario.expect]], scenario.name);
  }
});

test("only the structured resume-in-progress conflict enters the readiness wait", async () => {
  for (const error of [
    Object.assign(new Error("The agent is already being resumed"), { status: 403, code: "AGENT_RESUME_IN_PROGRESS" }),
    Object.assign(new Error("The agent is already being resumed"), { status: 409, code: "OTHER_CONFLICT" }),
  ]) {
    let reads = 0;
    const upstream = observeHarness({ internalApi: async method => {
      if (method === "POST") throw error;
      reads++; return { session: { id: "owned", mode: "chat", status: "exited" } };
    } });
    await assert.rejects(upstream.continuable("owned"), cause => cause.code === "AO_SESSION_RESTORE_UNCONFIRMED");
    assert.equal(reads, 1, "message text never impersonates the structured conflict");
  }
});

test("internal AO errors retain bounded structured status and code without changing their message", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("  async function internalApi(");
  const end = source.indexOf("  const agentId =", start);
  for (const data of [
    { code: "AGENT_RESUME_IN_PROGRESS", message: "restoring" },
    { error: { code: "AGENT_RESUME_IN_PROGRESS", message: "restoring" } },
  ]) {
    const api = require("node:vm").runInNewContext(source.slice(start, end) + "; internalApi", {
      // A write clears the shared session reads first (sharedObserveRead).
      sharedReads: new Map(),
      start: async () => {}, requestApi: async () => ({ ok: false, status: 409, data }),
      aoErrorMessage: () => "original unchanged message",
    });
    await assert.rejects(api("POST", "/api/v1/sessions/owned/resume-agent", {}), error =>
      error.status === 409 && error.code === "AGENT_RESUME_IN_PROGRESS" && error.message === "original unchanged message");
  }
});

test("resumed chats use live activity rather than PR-derived display status for readiness", async () => {
  const net = require("node:net");
  const root = fs.mkdtempSync(path.join(__dirname, "../../aiTemp/resume-host-"));
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.join(root, "chat-hosts", "owned"), { recursive: true });
  fs.writeFileSync(path.join(root, "chat-hosts", "owned", "host.json"), JSON.stringify({ address: "127.0.0.1:" + server.address().port }));
  try {
    for (const display of ["pr_open", "draft", "ci_failed", "review_pending", "changes_requested", "approved", "mergeable", "merged"]) {
      for (const hasActivity of [true, false]) {
        let restored = false, clock = 0;
        const upstream = observeHarness({
          dataRoot: root, Date: { now: () => clock },
          setTimeout: callback => { clock += 1000; setImmediate(callback); },
          internalApi: async method => {
            if (method === "POST") { restored = true; return { ok: true }; }
            return { session: { id: "owned", mode: "chat", status: restored ? display : "exited", provisionState: "ready",
              ...(hasActivity ? { activity: { state: restored ? "idle" : "exited" } } : {}) } };
          },
        });
        assert.equal(await upstream.continuable("owned"), true, display + " with a live host preserves the chat");
      }
    }
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test("an exited chat whose agent may live on is exited again once, so AO stops its leftover host", async () => {
  // Seen live: five chat hosts (1.4 GB) outlived a daemon restart; AO had marked their sessions
  // exited, and the idle sweep only looked at idle ones.
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async continuable(id)");
  const end = source.indexOf("    /** Sends a follow-up as a new turn", start);
  const methods = source.slice(start, end).trim().replace(/,$/, "");
  const helpers = source.slice(source.indexOf("  async function chatHostGone"), source.indexOf("  // Mission-owned AO calls."));
  const identity = source.slice(source.indexOf("  const sessionId ="), source.indexOf("  async function projectFor"));
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)[0];
  const now = Date.parse("2026-10-21T18:00:00Z");
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const sessions = [
    { id: "leftover", mode: "chat", status: "exited" },
    { id: "fresh-exit", mode: "chat", status: "exited" },
    { id: "gone", mode: "chat", status: "exited", isTerminated: true },
  ];
  const turns = { leftover: [{ state: "failed", completedAt: ago(360) }], "fresh-exit": [{ state: "completed", completedAt: ago(5) }], gone: [{ state: "failed", completedAt: ago(360) }] };
  const exits = [];
  const upstream = vm.runInNewContext(states + timelineBounds(source) + helpers + identity + "({" + methods + "})", {
    Buffer, fs, path, net: require("node:net"), dataRoot: path.join(os.tmpdir(), "ct-no-ao-data"), userMcpServers: null, Date, Math, Number, Promise, agentTools: null,
    exitedReleased: new Set(),
    internalApi: async (method, endpoint) => {
      if (endpoint === "/api/v1/sessions") return { sessions };
      const id = endpoint.split("/")[4];
      if (endpoint.endsWith("/conversation?limit=1")) return { turns: turns[id] ?? [] };
      if (endpoint.endsWith("/exit-agent")) { exits.push(id); throw new Error("AO: AGENT_EXITED: the agent has already exited"); }
      return { session: { id, mode: "chat", status: "exited" } };
    },
  });
  assert.deepEqual([...await upstream.idleChatSessions(30 * 60_000, now)], ["leftover"],
    "an exited chat idle past the limit; a recent one and a terminated one are left alone");
  assert.equal((await upstream.exitAgent("leftover")).ok, true, "AO's AGENT_EXITED counts as released (it stopped any leftover host)");
  assert.deepEqual(exits, ["leftover"]);
  assert.deepEqual([...await upstream.idleChatSessions(30 * 60_000, now)], [], "and it is not asked again this run");
});

test("chats AO still calls working with no agent activity for long are listed, so their stranded hosts can be stopped", async () => {
  // Seen 2026-10-22: two chat hosts and their agents ran on, quiet 8 hours and a day, their sessions
  // "working" for good after their turns died with a restart; nothing looked at working sessions.
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  const start = source.indexOf("    async quietWorkingChatSessions(");
  const end = source.indexOf("    /**", start);
  const method = source.slice(start, end).trim().replace(/,$/, "");
  const now = Date.parse("2026-10-22T10:30:00Z");
  const ago = minutes => new Date(now - minutes * 60_000).toISOString();
  const sessions = [
    { id: "stranded", mode: "chat", status: "working", activity: { state: "active", lastActivityAt: ago(24 * 60) } },
    { id: "busy", mode: "chat", status: "working", activity: { state: "active", lastActivityAt: ago(5) } },
    { id: "idle", mode: "chat", status: "idle", activity: { state: "idle", lastActivityAt: ago(24 * 60) } },
    { id: "ended", mode: "chat", status: "working", isTerminated: true, activity: { lastActivityAt: ago(24 * 60) } },
    { id: "worker", mode: "worker", status: "working", activity: { lastActivityAt: ago(24 * 60) } },
    { id: "unknown", mode: "chat", status: "working", activity: {} },
  ];
  const upstream = vm.runInNewContext("({" + method + "})", { Date, Number, Array, String,
    internalApi: async (method, endpoint) => { assert.equal(endpoint, "/api/v1/sessions"); return { sessions }; } });
  assert.deepEqual([...await upstream.quietWorkingChatSessions(2 * 60 * 60_000, now)], ["stranded"],
    "only a live chat quiet past the limit: not a busy one, an idle or ended one, a non-chat, or one with no activity time");
});
