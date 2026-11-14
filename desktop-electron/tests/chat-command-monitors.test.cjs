"use strict";

// monitor (chat-command-monitors.cjs): Claude Code's Monitor for the app's chat agents. Each stdout
// line of the monitored command is an event; exit or the deadline ends it.

require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCommandMonitors, monitorTimeout, batchLines, MONITOR_TOOL_DEFS } = require("../electron/chat-command-monitors.cjs");
const { createChatAgentTools } = require("../electron/chat-agent-tools.cjs");
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.ok(check());
}

const settle = () => new Promise(resolve => setImmediate(resolve));
function fakeClock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { at: time + Math.max(0, ms), fn }); return id; },
    clearTimer: id => { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        await settle();
      }
      time = end;
      await settle();
    },
  };
}
/** A command whose stdout grows by the chunks pushed; `exit()` ends it. */
function fakeCommand() {
  let output = "", status = "running", exitCode = null;
  return {
    push: text => { output += text; },
    exit: (code = 0) => { status = "exited"; exitCode = code; },
    read: async offset => ({ content: output.slice(offset), nextOffset: output.length, gap: false, status, exitCode }),
  };
}
function ticket() {
  const seen = { events: [], ended: null, cancelled: false };
  return { seen, value: { emit: events => { seen.events.push(...events); }, end: outcome => { seen.ended = outcome; }, cancel: () => { seen.cancelled = true; } } };
}

test("monitor's schema is Claude Code's MonitorInput: description, timeout_ms and command", () => {
  const monitor = MONITOR_TOOL_DEFS.find(tool => tool.name === "monitor");
  assert.deepEqual(monitor.inputSchema.required, ["description", "timeout_ms", "command"]);
  assert.match(monitor.inputSchema.properties.timeout_ms.description, /Default 300000ms\. Deadlines above 1800000ms are capped to 1800000ms/);
  assert.match(monitor.inputSchema.properties.command.description, /Each stdout line is an event; exit ends the watch/);
  assert.equal(monitorTimeout(undefined), 300_000);
  assert.equal(monitorTimeout(3_600_000), 1_800_000, "capped like Claude Code's");
  assert.throws(() => monitorTimeout(10), /at least 1000/);
});

test("a run of the same line is one event with its count; distinct lines keep their order", () => {
  assert.deepEqual(batchLines([]), []);
  assert.deepEqual(batchLines(["a", "b"]), ["a", "b"]);
  assert.deepEqual(batchLines(["waiting", "waiting", "waiting", "ready", "waiting"]),
    ["waiting (repeated 3 times)", "ready", "waiting"], "only adjacent repeats fold; a later repeat is its own event");
});

test("each complete stdout line is an event; a partial line waits, and exit ends the monitor with its code", async () => {
  const clock = fakeClock();
  const monitors = createCommandMonitors(clock);
  const command = fakeCommand();
  const { seen, value } = ticket();
  const started = await monitors.start({ owner: "chat", description: "build log", timeoutMs: 60_000, commandId: "cmd-1",
    active: () => true, read: command.read, prepare: async () => value });
  assert.equal(started.status, "running");
  command.push("step 1 ok\nstep 2 ok\nstep 3 par");
  await clock.advance(1500);
  assert.deepEqual(seen.events, ["step 1 ok", "step 2 ok"], "the unfinished line is held back");
  command.push("tial\n\n   \nFAILED: step 4\n");
  await clock.advance(1500);
  assert.deepEqual(seen.events.slice(2), ["step 3 partial", "FAILED: step 4"], "blank lines are not events");
  command.push("tail without newline");
  command.exit(2);
  await clock.advance(3000);
  assert.equal(seen.events.at(-1), "tail without newline", "the last unfinished line is sent at exit");
  assert.deepEqual(seen.ended, { kind: "exited", status: "exited", exit_code: 2 });
  assert.equal(monitors.list("chat")[0].status, "exited");
});

test("the deadline ends the monitor as expired; stop cancels its delivery", async () => {
  const clock = fakeClock();
  const monitors = createCommandMonitors(clock);
  const first = ticket();
  await monitors.start({ owner: "chat", description: "ci", timeoutMs: 5000, commandId: "cmd-1", active: () => true,
    read: fakeCommand().read, prepare: async () => first.value });
  await clock.advance(6000);
  assert.equal(first.seen.ended?.kind, "expired");
  const second = ticket();
  const started = await monitors.start({ owner: "chat", description: "log", timeoutMs: 60_000, commandId: "cmd-2", active: () => true,
    read: fakeCommand().read, prepare: async () => second.value });
  assert.equal(monitors.commandOf("chat", started.monitor_id), "cmd-2");
  assert.equal(monitors.commandOf("other chat", started.monitor_id), null, "only its own chat can see it");
  assert.equal(monitors.stop("other chat", started.monitor_id), false);
  assert.equal(monitors.stop("chat", started.monitor_id), true);
  assert.equal(second.seen.cancelled, true);
  assert.equal(monitors.list("chat").find(item => item.monitor_id === started.monitor_id).status, "stopped");
});

test("a monitor that floods the chat is stopped, and one whose output cannot be read gives up after three tries", async () => {
  const clock = fakeClock();
  const monitors = createCommandMonitors(clock);
  const command = fakeCommand();
  const noisy = ticket();
  await monitors.start({ owner: "chat", description: "noisy", timeoutMs: 600_000, commandId: "cmd-1", active: () => true,
    read: command.read, prepare: async () => noisy.value });
  command.push(Array.from({ length: 250 }, (_, index) => `line ${index}`).join("\n") + "\n");
  await clock.advance(1500);
  assert.equal(noisy.seen.ended?.kind, "flooded");
  const broken = ticket();
  await monitors.start({ owner: "chat", description: "broken", timeoutMs: 600_000, commandId: "cmd-2", active: () => true,
    read: async () => { throw new Error("gone"); }, prepare: async () => broken.value });
  await clock.advance(5000);
  assert.equal(broken.seen.ended?.kind, "failed");
});

test("a chat that is no longer active cancels its monitor; at most eight run per chat", async () => {
  const clock = fakeClock();
  const monitors = createCommandMonitors(clock);
  let active = true;
  const gone = ticket();
  await monitors.start({ owner: "chat", description: "x", timeoutMs: 60_000, commandId: "cmd-0", active: () => active,
    read: fakeCommand().read, prepare: async () => gone.value });
  active = false;
  await clock.advance(1500);
  assert.equal(gone.seen.cancelled, true);
  for (let index = 1; index <= 8; index += 1) {
    await monitors.start({ owner: "busy", description: `m${index}`, timeoutMs: 60_000, commandId: `cmd-${index}`, active: () => true,
      read: fakeCommand().read, prepare: async () => ticket().value });
  }
  await assert.rejects(monitors.start({ owner: "busy", description: "ninth", timeoutMs: 60_000, commandId: "cmd-9", active: () => true,
    read: fakeCommand().read, prepare: async () => ticket().value }), /Too many running monitors/);
  monitors.close();
});

/** A chat agent's MCP server with a fake headless whose one command prints what the test pushes. */
async function monitorWorld({ agent = "codex", notify = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-monitor-"));
  let output = "", status = "running";
  const calls = [], events = [], ends = [], notices = [];
  const tools = createChatAgentTools({ terminalEnabled: () => true, logger: {},
    commandEvents: {
      register: async () => ({ complete: async () => "delivered", cancel() {} }),
      monitor: async request => ({ request, emit: lines => { events.push(...lines); }, end: outcome => { ends.push(outcome); }, cancel() {} }),
    },
    notifyUser: notify ? async request => { notices.push(request); } : null,
    sessionWorkspace: async () => ({ root }),
    requestHeadless: async (endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint.includes("catalog")) return { tools: ["exec_command", "write_stdin", "read_output", "kill_command"].map(name => ({ name, inputSchema: { type: "object" } })) };
      const result = body.tool === "exec_command" ? { ok: true, command_id: "cmd-mon", status: "running", exit_code: null }
        : body.tool === "read_output" ? { ok: true, content: output.slice(body.arguments.offset ?? 0), next_read_offset: output.length, output_gap: false, status, exit_code: status === "running" ? null : 0 }
        : body.tool === "kill_command" ? (status = "exited", { ok: true, command_id: "cmd-mon", status: "exited", termination_reason: "killed", exit_code: null })
        : { ok: true };
      return { ok: true, operation: { state: "completed", result } };
    },
  });
  const lease = await tools.lease({ workspaceId: "ws", agent, approvalMode: "bypass-permissions" });
  lease.bind("session");
  const server = lease.servers[0];
  let id = 0;
  const rpc = async (method, params) => (await (await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json()).result;
  return { rpc, call: (name, args = {}) => rpc("tools/call", { name, arguments: args }), calls, events, ends, notices,
    push: text => { output += text; }, exit: () => { status = "exited"; },
    close: async () => { await tools.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const agent of ["codex", "claude-code", "opencode"]) {
  test(`${agent} gets monitor, push_notification and sleep; a monitor's stdout lines reach the chat until its command exits`, async () => {
    const world = await monitorWorld({ agent });
    try {
      const names = (await world.rpc("tools/list")).tools.map(tool => tool.name);
      for (const name of ["monitor", "list_monitors", "stop_monitor", "push_notification", "sleep"]) assert.ok(names.includes(name), name);
      const started = await world.call("monitor", { description: "deploy steps", timeout_ms: 120_000, command: "node deploy-watch.cjs" });
      assert.equal(started.isError, false, JSON.stringify(started));
      assert.equal(started.structuredContent.status, "running");
      assert.match(started.structuredContent.monitor_id, /^monitor-/);
      const exec = world.calls.find(call => call.body?.tool === "exec_command").body.arguments;
      assert.equal(exec.cmd, "node deploy-watch.cjs");
      assert.equal(exec.yield_time_ms, 0, "the command runs in the background");
      assert.equal(exec.timeout_ms, 120_000, "and is stopped at the monitor's deadline");
      world.push("build ok\npublish FAILED: 503\n");
      await until(() => world.events.length === 2);
      assert.deepEqual(world.events, ["build ok", "publish FAILED: 503"]);
      world.exit();
      await until(() => world.ends.length === 1);
      assert.equal(world.ends[0].kind, "exited");
      assert.equal((await world.call("list_monitors")).structuredContent.monitors[0].status, "exited");
    } finally { await world.close(); }
  });
}

test("stop_monitor stops the monitor and its command; a bad monitor call runs nothing", async () => {
  const world = await monitorWorld();
  try {
    const invalid = await world.call("monitor", { description: "x", timeout_ms: 60_000, command: "  " });
    assert.equal(invalid.isError, true);
    assert.equal(world.calls.some(call => call.body?.tool === "exec_command"), false, "nothing was run");
    const started = await world.call("monitor", { description: "log tail", timeout_ms: 60_000, command: "node tail.cjs" });
    const stopped = await world.call("stop_monitor", { monitor_id: started.structuredContent.monitor_id });
    assert.deepEqual(stopped.structuredContent, { ok: true, stopped: true, command_stopped: true });
    assert.equal(world.calls.filter(call => call.body?.tool === "kill_command").length, 1);
  } finally { await world.close(); }
});

test("push_notification reaches the notifier, and sleep returns the elapsed time", async () => {
  const world = await monitorWorld();
  try {
    const sent = await world.call("push_notification", { message: "Deploy failed: publish returned 503", status: "proactive" });
    assert.notEqual(sent.isError, true, JSON.stringify(sent));
    assert.deepEqual(world.notices, [{ workspaceId: "ws", session: "session", message: "Deploy failed: publish returned 503", proactive: true }]);
    const slept = await world.call("sleep", { duration_ms: 50 });
    assert.equal(slept.structuredContent.ended, "elapsed");
    assert.ok(slept.structuredContent.elapsed_ms >= 40, String(slept.structuredContent.elapsed_ms));
    assert.equal((await world.call("sleep", { duration_ms: 0 })).isError, true);
  } finally { await world.close(); }
  const quiet = await monitorWorld({ notify: false });
  try {
    assert.equal((await quiet.rpc("tools/list")).tools.some(tool => tool.name === "push_notification"), false, "no notifier, no tool");
  } finally { await quiet.close(); }
});
