"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCommandWatches } = require("../electron/chat-command-watches.cjs");
const { createChatAgentTools, instructionsFor } = require("../electron/chat-agent-tools.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.ok(check()); }
function clocked() {
  let at = 1000, sequence = 0, active = true, value = { ok: true, status: "running" }, reads = 0, cancelled = 0;
  const timers = new Map(), events = [], owner = {};
  const watches = createCommandWatches({ now: () => at,
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: at + ms }); return id; }, clearTimer: id => timers.delete(id) });
  const input = { owner, commandId: "cmd-one", reason: "verify the build and continue", timeoutMs: 10_000, active: () => active,
    inspect: async () => { reads++; return typeof value === "function" ? value() : value; },
    prepare: async () => ({ complete: async outcome => { events.push(outcome); return "delivered"; }, cancel: () => { cancelled++; } }) };
  const advance = async ms => { at += ms; for (let i = 0; i < 10; i++) { const due = [...timers].filter(([, timer]) => timer.at <= at); if (!due.length) break; for (const [id, timer] of due) { timers.delete(id); timer.fn(); } await tick(); await tick(); } };
  return { watches, input, owner, events, timers, advance, set: next => { value = next; }, inactive: () => { active = false; }, get reads() { return reads; }, get cancelled() { return cancelled; } };
}

test("a registered command watch completes once, with no model polling or process launch", async () => {
  const state = clocked();
  try {
    const first = await state.watches.watch(state.input);
    assert.equal(first.status, "watching");
    assert.notEqual((await state.watches.watch(state.input)).watch_id, first.watch_id, "an explicit repeat refreshes current-turn ownership");
    assert.equal(state.watches.list(state.owner).filter(watch => watch.status === "watching").length, 1);
    await state.advance(1);
    assert.equal(state.reads, 1);
    state.set({ ok: true, status: "exited", exit_code: 0, command_ok: true });
    await state.advance(5000);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].command_ok, true);
    assert.equal(state.watches.list(state.owner).at(-1).delivery, "delivered");
    await state.advance(60_000);
    assert.equal(state.events.length, 1);
  } finally { state.watches.close(); }
});

for (const status of ["killed", "timed_out", "spawn_failed"]) {
  test(`watch completion preserves ${status}, not an implicit success`, async () => {
    const state = clocked();
    try {
      state.set({ ok: true, status: "exited", termination_reason: status, exit_code: null, command_ok: false });
      await state.watches.watch(state.input); await state.advance(1);
      assert.equal(state.events[0].termination_reason, status);
      assert.equal(state.events[0].command_ok, false);
    } finally { state.watches.close(); }
  });
}

test("a hung observation expires independently and a late result cannot redeliver", async () => {
  const state = clocked(); let release;
  try {
    state.set(() => new Promise(resolve => { release = resolve; }));
    await state.watches.watch(state.input); await state.advance(1); await state.advance(10_000);
    assert.equal(state.events[0].kind, "expired");
    release({ ok: true, status: "exited", exit_code: 0 }); await tick();
    assert.equal(state.events.length, 1);
  } finally { state.watches.close(); }
});

test("three observation errors yield an unknown-outcome notification", async () => {
  const state = clocked();
  try {
    state.input.timeoutMs = 60_000;
    state.set(() => { throw new Error("offline"); });
    await state.watches.watch(state.input); await state.advance(1); await state.advance(5000); await state.advance(5000);
    assert.equal(state.events.length, 1); assert.equal(state.events[0].kind, "failed");
    assert.match(state.events[0].note, /unknown|never blindly/);
  } finally { state.watches.close(); }
});

for (const change of ["cancel", "disable", "dispose"]) {
  test(`${change} retires a watch without delivering a late completion`, async () => {
    const state = clocked(); let release;
    try {
      state.set(() => new Promise(resolve => { release = resolve; }));
      const record = await state.watches.watch(state.input); await state.advance(1);
      assert.equal(state.watches.cancel({}, record.watch_id), false, "other chats cannot cancel it");
      assert.deepEqual(state.watches.list({}), []);
      if (change === "cancel") state.watches.cancel(state.owner, record.watch_id);
      else if (change === "disable") { state.inactive(); await state.advance(10_000); }
      else state.watches.close();
      release({ ok: true, status: "exited", exit_code: 0 }); await tick(); await state.advance(60_000);
      assert.deepEqual(state.events, []);
    } finally { state.watches.close(); }
  });
}

test("watch validation and per-chat active limits are bounded", async () => {
  const state = clocked();
  try {
    for (const change of [{ commandId: "../foreign" }, { reason: " " }, { timeoutMs: 0 }, { timeoutMs: 86_400_001 }]) await assert.rejects(state.watches.watch({ ...state.input, ...change }));
    for (let i = 0; i < 16; i++) await state.watches.watch({ ...state.input, commandId: `cmd-${i}` });
    await assert.rejects(state.watches.watch({ ...state.input, commandId: "too-many" }), /Too many/);
    assert.equal(state.watches.list(state.owner).length, 16);
  } finally { state.watches.close(); }
});

for (const ending of ["expired", "failed"]) {
  test(`an explicit new watch can rearm the same still-running handle after ${ending}`, async () => {
    const state = clocked();
    try {
      const first = await state.watches.watch(state.input);
      if (ending === "expired") await state.advance(10_000);
      else {
        state.set(() => { throw new Error("temporarily unavailable"); });
        state.input.timeoutMs = 60_000;
        state.watches.cancel(state.owner, first.watch_id);
        await state.watches.watch(state.input);
        await state.advance(1); await state.advance(5000); await state.advance(5000);
      }
      assert.equal(state.events.at(-1).kind, ending);
      state.set({ ok: true, status: "running" });
      const next = await state.watches.watch(state.input);
      assert.equal(next.status, "watching");
      assert.notEqual(next.watch_id, first.watch_id);
      assert.equal(state.watches.list(state.owner).at(-1).delivery, "armed");
    } finally { state.watches.close(); }
  });
}

test("pending deliveries in another chat do not consume this chat's watch allowance", async () => {
  const state = clocked();
  try {
    state.set({ ok: true, status: "exited", exit_code: 0 });
    const input = { ...state.input, prepare: async () => ({ complete: () => new Promise(() => {}), cancel() {} }) };
    for (let i = 0; i < 16; i++) await state.watches.watch({ ...input, commandId: `finished-${i}` });
    await state.advance(1);
    assert.equal((await state.watches.watch({ ...state.input, owner: {}, commandId: "other-chat" })).status, "watching");
  } finally { state.watches.close(); }
});

test("cancelling a registration settles its call immediately and fences its late ticket", async () => {
  const state = clocked(); let release, result, cancelled = 0;
  try {
    const pending = state.watches.watch({ ...state.input, prepare: () => new Promise(resolve => { release = resolve; }) });
    pending.then(value => { result = value; }, error => { result = error; });
    await tick(); state.watches.cancelOwner(state.owner); await tick();
    assert.ok(result instanceof Error, "Stop must not leave registration pending until its old deadline");
    release({ complete: async () => { throw new Error("late send"); }, cancel: () => { cancelled++; } });
    await tick(); assert.equal(cancelled, 1);
    assert.equal(state.watches.list(state.owner)[0].status, "cancelled");
  } finally { state.watches.close(); release?.({ complete: async () => "delivered", cancel() {} }); }
});

async function mcpWorld({ enabled = () => true, service = true, agent = "codex", subagent = false, sandboxed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-command-watch-"));
  let status = "running", completed = [], registered = 0;
  const calls = [], commandId = sandboxed ? "sbx-command" : "cmd-headless";
  const snapshot = () => ({ ok: true, command_id: commandId, status, exit_code: status === "running" ? null : 0, command_ok: status === "running" ? null : true });
  const tools = createChatAgentTools({ enabled, terminalEnabled: () => true, logger: {},
    commandEvents: service ? { register: async request => { registered++; return { complete: async outcome => { completed.push({ request, outcome }); return "delivered"; }, cancel() {} }; } } : null,
    sessionWorkspace: async () => ({ root }),
    sandbox: sandboxed ? { available: () => true, start: async () => commandId, owns: id => id === commandId, wait: async () => {}, snapshot } : null,
    requestHeadless: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint.includes("catalog")) return { tools: [{ name: "exec_command", inputSchema: { type: "object" } }, { name: "write_stdin", inputSchema: { type: "object" } }] };
      return { ok: true, operation: { state: "completed", result: snapshot() } };
    },
  });
  const lease = await tools.lease({ workspaceId: "ws", agent, approvalMode: "bypass-permissions", subagent });
  lease.bind("session"); let server = lease.servers[0], id = 0;
  const rpc = async (method, params) => (await (await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json()).result;
  const call = (name, args = {}) => rpc("tools/call", { name, arguments: args });
  return { tools, call, rpc, completed, calls, root, use: next => { server = next; }, finish: () => { status = "exited"; }, get registered() { return registered; },
    close: async () => { await tools.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const agent of ["codex", "claude-code", "opencode"]) {
  test(`${agent} discovers real watch tools and registers completion delivery`, async () => {
    const state = await mcpWorld({ agent });
    try {
      const init = await state.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      assert.match(init.instructions, /watch_command[\s\S]*prose alone schedules no work/);
      const listed = (await state.rpc("tools/list")).tools;
      for (const name of ["watch_command", "list_command_watches", "cancel_command_watch"]) assert.ok(listed.some(tool => tool.name === name), name);
      await state.call("exec_command", { cmd: "node task.cjs", yield_time_ms: 0 });
      assert.equal((await state.call("watch_command", { command_id: "foreign", reason: "check it" })).isError, true);
      state.finish();
      const watched = await state.call("watch_command", { command_id: "sbx-command", reason: "verify and proceed", timeout_ms: 10_000 });
      assert.equal(watched.structuredContent.status, "watching");
      assert.match(watched.structuredContent.watch_id, /^watch-/);
      state.finish(); await until(() => state.completed.length === 1);
      assert.equal(state.completed[0].request.workspaceId, "ws");
      assert.equal(state.completed[0].request.session, "session");
      assert.equal(state.completed[0].outcome.command_ok, true);
      assert.equal(state.registered, 1);
    } finally { await state.close(); }
  });
}

test("an already delivered completion never promises another nonexistent follow-up", async () => {
  const state = await mcpWorld();
  try {
    await state.call("exec_command", { cmd: "node build.cjs", yield_time_ms: 0 }); state.finish();
    await state.call("watch_command", { command_id: "sbx-command", reason: "check the finished build" });
    await until(() => state.completed.length === 1);
    const repeated = (await state.call("watch_command", { command_id: "sbx-command", reason: "check again" })).structuredContent;
    assert.equal(repeated.status, "completed");
    assert.match(repeated.next_action, /already ended[\s\S]*continue.*now/i);
    assert.equal(state.completed.length, 1);
  } finally { await state.close(); }
});

test("headless commands are watched with scoped empty-input reads, never a replay", async () => {
  const state = await mcpWorld({ sandboxed: false });
  try {
    await state.call("exec_command", { cmd: "node build.cjs", yield_time_ms: 0 });
    state.finish();
    const watched = await state.call("watch_command", { command_id: "cmd-headless", reason: "check the build" });
    assert.equal(watched.structuredContent.status, "watching");
    await until(() => state.completed.length === 1);
    const calls = state.calls.filter(call => call.endpoint === "/api/v1/tools/call");
    assert.equal(calls.filter(call => call.body.tool === "exec_command").length, 1);
    const poll = calls.find(call => call.body.tool === "write_stdin").body;
    assert.equal(poll.arguments.chars, "");
    assert.equal(poll.arguments.command_id, "cmd-headless");
    assert.equal(poll.root, state.root);
  } finally { await state.close(); }
});

for (const action of ["cancel", "Stop"]) {
  test(`MCP ${action} cancels observation and pending continuation, not the command`, async () => {
    const state = await mcpWorld();
    try {
      await state.call("exec_command", { cmd: "node build.cjs", yield_time_ms: 0 });
      const watch = (await state.call("watch_command", { command_id: "sbx-command", reason: "check the build" })).structuredContent;
      if (action === "Stop") state.tools.cancelSessionCalls("session");
      else assert.equal((await state.call("cancel_command_watch", { watch_id: watch.watch_id })).structuredContent.command_stopped, false);
      state.finish(); await tick(); await tick();
      const listed = (await state.call("list_command_watches")).structuredContent.watches;
      assert.equal(listed[0].status, "cancelled");
      assert.deepEqual(state.completed, []);
    } finally { await state.close(); }
  });
}

test("credential renewal preserves watch ownership without reviving the retired credential", async () => {
  const state = await mcpWorld();
  try {
    await state.call("exec_command", { cmd: "node build.cjs", yield_time_ms: 0 });
    state.finish();
    const watch = (await state.call("watch_command", { command_id: "sbx-command", reason: "continue after the build" })).structuredContent;
    state.use((await state.tools.renew("session")).servers[0]);
    const listed = (await state.call("list_command_watches")).structuredContent.watches;
    assert.equal(listed[0].watch_id, watch.watch_id);
    await until(() => state.completed.length === 1);
    assert.equal(state.registered, 1);
  } finally { await state.close(); }
});

for (const options of [{ service: false }, { subagent: true }]) {
  test(`unavailable watch service or subagent never advertises or accepts watch tools ${JSON.stringify(options)}`, async () => {
    const state = await mcpWorld(options);
    try {
      assert.ok(!(await state.rpc("tools/list")).tools.some(tool => tool.name === "watch_command"));
      assert.equal((await state.call("watch_command", { command_id: "sbx-command", reason: "x" })).isError, true);
    } finally { await state.close(); }
  });
}

test("agent guidance does not claim nonexistent watches, and distinguishes real continuation from promises", () => {
  assert.doesNotMatch(instructionsFor(["agent"], { wakeups: false }), /call watch_command/i);
  assert.match(instructionsFor(["terminal"], { watches: true }), /command running in a terminal alone does not schedule/i);
});
