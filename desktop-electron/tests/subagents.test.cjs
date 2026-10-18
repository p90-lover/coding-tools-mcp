"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSubagents, cleanConfig, SUBAGENT_TOOLS, STARTERS } = require("../electron/subagents.cjs");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const ROUTE = { harness_id: "ao:claude-code", model: "cpa/test-model" };
const parse = (result) => JSON.parse(result.content[0].text);

/** A subagents service over a fake AO harness whose sessions the test drives. */
function world({ settings = {}, agents = null, now = () => 1_000_000, aoUp = () => true, setTimer = undefined } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
  const spawned = [], resolved = [], inputs = [], interrupted = [], released = [];
  const sessions = new Map();
  let next = 0;
  const harness = {
    spawn: async (input) => { spawned.push(input); const id = `sub-${++next}`; sessions.set(id, { turnState: "queued", approvals: [] }); return id; },
    observe: async (id) => ({ turnId: "t1", ...sessions.get(id) }),
    resolveApproval: async (id, approvalId, decision) => { resolved.push([id, approvalId, decision]); },
    resolveInput: async (id, approvalId, action, content) => { inputs.push([id, approvalId, action, content]); },
    interrupt: async (id) => { interrupted.push(id); },
    exitAgent: async (id) => { released.push(id); },
  };
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: async () => ({ ok: true }) });
  const service = createSubagents({
    statePath: path.join(dir, "subagents.json"),
    launchArgs: (workspaceId, route, name) => workflow.subagentLaunchArgs(workspaceId, route, name),
    harness: () => (aoUp() ? harness : null), blockedRequest: workflow.blockedRequest, recommendedAnswer: workflow.recommendedAnswer,
    logger: { info() {}, warn() {} }, now, ...(setTimer ? { setTimer } : {}),
  });
  service.save({ settings: { defaultRoute: ROUTE, ...settings }, agents: agents ?? STARTERS });
  return { service, harness, sessions, spawned, resolved, inputs, interrupted, released, dir,
    cleanup: () => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("the saved settings and subagents are validated and kept", () => {
  const w = world();
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(w.dir, "subagents.json"), "utf8"));
    assert.deepEqual(saved.agents.map((agent) => agent.id), ["explorer", "implementer", "reviewer"], "the starters until the user changes them");
    assert.equal(saved.settings.maxConcurrent, 3);
    assert.deepEqual(saved.settings.defaultRoute, ROUTE);
    const clamped = cleanConfig({ settings: { maxConcurrent: 99, timeoutMinutes: 0, permission: "nonsense" }, agents: [] }).settings;
    assert.equal(clamped.maxConcurrent, 10);
    assert.equal(clamped.timeoutMinutes, 1);
    assert.equal(clamped.permission, "auto");
    assert.throws(() => cleanConfig({ agents: [{ name: "a" }, { name: "A" }] }), /share the id/);
    assert.throws(() => cleanConfig({ agents: [{ name: "x", route: { harness_id: "codex-native", model: "m" } }] }), /Agent Orchestrator agent/);
    assert.throws(() => cleanConfig({ agents: [{ name: "x", route: { harness_id: "ao:codex", model: "cpa/chatgpt-web/high" } }] }), /WebGPT/);
    assert.throws(() => cleanConfig({ agents: [{ name: "x", route: { harness_id: "ao:codex", model: "m", effort: "turbo" } }] }), /effort/);
  } finally { w.cleanup(); }
});

test("a chat agent starts a subagent on its route as a plain, unattended AO session and reads its report", async () => {
  const w = world();
  try {
    const listed = parse(await w.service.call("chat-1", "ws-1", "subagent_list", {}));
    assert.deepEqual(listed.subagents.map((agent) => [agent.id, agent.ready]), [["explorer", true], ["implementer", true], ["reviewer", true]]);
    const started = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "reviewer", task: "Review src/auth.ts" }));
    assert.equal(started.state, "starting");
    const [spawn] = w.spawned;
    assert.equal(spawn.workspaceId, "ws-1");
    assert.equal(spawn.agent, "claude-code");
    assert.equal(spawn.plain, true);
    assert.equal(spawn.subagent, true, "its session gets no subagents of its own");
    assert.equal(spawn.autoReview, true, "Approve for me by default");
    assert.deepEqual(spawn.gateway, { provider: "cpa", model: "test-model" });
    assert.match(spawn.prompt, /You review code for correctness/);
    assert.match(spawn.prompt, /Task:\nReview src\/auth.ts$/);
    w.sessions.set(started.subagent_id, { turnState: "completed", answer: "No bugs found in src/auth.ts.", approvals: [] });
    const result = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 }));
    assert.equal(result.state, "completed");
    assert.equal(result.report, "No bugs found in src/auth.ts.");
    assert.deepEqual(w.released, [started.subagent_id], "its agent is released when done");
    const other = await w.service.call("chat-2", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 });
    assert.equal(other.isError, true, "another chat cannot read it");
  } finally { w.cleanup(); }
});

test("requests a subagent raises are answered for it, except what the safety rules block", async () => {
  const w = world();
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "implementer", task: "add a test" }));
    const decisions = [{ id: "allow", kind: "allow_once" }, { id: "deny", kind: "reject_once" }];
    w.sessions.set(id, { turnState: "running", approvals: [
      { approval_id: "a1", kind: "command", tool: "Bash", command: "npm test", decisions },
      { approval_id: "a2", kind: "command", tool: "Bash", command: "git push origin main", decisions },
      { approval_id: "a3", kind: "question", mode: "form", fields: [{ key: "pick", type: "choice", options: [
        { value: "a", label: "A", description: "" }, { value: "b", label: "B (Recommended)", description: "" }] }] },
      { approval_id: "a4", kind: "plan", decisions: [{ id: "default", kind: "allow_once" }, { id: "acceptEdits", kind: "allow_always" }] },
    ] });
    parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.deepEqual(w.resolved, [[id, "a1", "allow"], [id, "a2", "deny"], [id, "a4", "acceptEdits"]]);
    assert.deepEqual(w.inputs, [[id, "a3", "accept", { pick: "b" }]]);
    parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.equal(w.resolved.length, 3, "each request is answered once");
  } finally { w.cleanup(); }
});

test("limits: running at once, per chat, and the time limit", async () => {
  let clock = 1_000_000;
  const w = world({ settings: { maxConcurrent: 2, maxPerChat: 1, timeoutMinutes: 5 }, now: () => clock });
  try {
    const first = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "one" }));
    const again = await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "two" });
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /limit per chat/);
    parse(await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "three" }));
    const third = await w.service.call("chat-3", "ws-1", "subagent_start", { agent: "explorer", task: "four" });
    assert.match(third.content[0].text, /2 subagents are already running/);
    clock += 6 * 60_000;
    const timedOut = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: first.subagent_id, wait_seconds: 0 }));
    assert.equal(timedOut.state, "timed_out");
    assert.deepEqual(w.interrupted, [first.subagent_id]);
    const stopped = parse(await w.service.call("chat-2", "ws-1", "subagent_stop", { subagent_id: "sub-2" }));
    assert.equal(stopped.state, "stopped");
    assert.equal(parse(await w.service.call("chat-3", "ws-1", "subagent_start", { agent: "explorer", task: "five" })).state, "starting", "room again");
  } finally { w.cleanup(); }
});

test("a subagent with no model, a disabled one, or subagents turned off cannot start", async () => {
  const w = world({ settings: { defaultRoute: null }, agents: [{ name: "Solo", route: null }, { name: "Off", enabled: false, route: ROUTE }] });
  try {
    assert.match((await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "solo", task: "x" })).content[0].text, /has no model/);
    assert.match((await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "off", task: "x" })).content[0].text, /No enabled subagent/);
    w.service.save({ settings: { enabled: false, defaultRoute: ROUTE }, agents: [{ name: "Solo" }] });
    assert.equal(w.service.enabled(), false);
    assert.match((await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "solo", task: "x" })).content[0].text, /turned off/);
    assert.equal(w.spawned.length, 0);
  } finally { w.cleanup(); }
});

test("Full access starts subagents with permissions bypassed; opencode keeps its own mode", async () => {
  const w = world({ settings: { permission: "full" }, agents: [{ name: "Fast" }, { name: "Open", route: { harness_id: "ao:opencode", model: "cpa/test-model" } }] });
  try {
    await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "fast", task: "x" });
    assert.equal(w.spawned[0].approvalMode, "bypass-permissions");
    assert.equal(w.spawned[0].autoReview, undefined);
    await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "open", task: "y" });
    assert.equal(w.spawned[1].agent, "opencode");
    assert.equal(w.spawned[1].approvalMode, undefined);
    assert.equal(w.spawned[1].model, "openai/test-model", "opencode names a CPA model through its OpenAI provider");
  } finally { w.cleanup(); }
});

test("chat agents get the subagent tools when subagents are on; a subagent's own session does not", async () => {
  const { createChatAgentTools } = require("../electron/chat-agent-tools.cjs");
  let enabled = true;
  const calls = [];
  const subagents = { enabled: () => enabled, describe: () => "reviewer (Reviews changes)", call: async (...args) => { calls.push(args); return { content: [{ type: "text", text: "{}" }], isError: false }; } };
  const tools = createChatAgentTools({ subagents, logger: { info() {}, warn() {} }, minAnswerMs: 0,
    sessionWorkspace: async () => ({ ready: false }),
    requestHeadless: async (endpoint) => (endpoint.startsWith("/api/v1/tools/catalog?") ? { tools: [] } : { ok: true }) });
  const post = async (url, auth, body) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth }, body: JSON.stringify(body) });
    return JSON.parse(await response.text());
  };
  try {
    const chat = await tools.lease({ agent: "claude-code", workspaceId: "ws1" });
    chat.bind("chat-1");
    const [{ url, headers }] = chat.servers;
    const init = await post(url, headers.Authorization, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.match(init.result.instructions, /subagent_start/);
    assert.match(init.result.instructions, /reviewer \(Reviews changes\)/);
    const list = await post(url, headers.Authorization, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.deepEqual(list.result.tools.map((tool) => tool.name).filter((name) => SUBAGENT_TOOLS.has(name)).sort(), [...SUBAGENT_TOOLS].sort());
    await post(url, headers.Authorization, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "subagent_start", arguments: { agent: "reviewer", task: "t", confirm: true } } });
    assert.deepEqual(calls, [["chat-1", "ws1", "subagent_start", { agent: "reviewer", task: "t" }]], "routed with the chat's own session; consent arguments stripped");

    const sub = await tools.lease({ agent: "claude-code", workspaceId: "ws1", subagent: true });
    sub.bind("sub-1");
    const subList = await post(sub.servers[0].url, sub.servers[0].headers.Authorization, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    assert.equal(subList.result.tools.some((tool) => SUBAGENT_TOOLS.has(tool.name)), false, "one level only");

    enabled = false;
    const off = await post(url, headers.Authorization, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
    assert.equal(off.result.tools.some((tool) => SUBAGENT_TOOLS.has(tool.name)), false, "turned off on the Subagents page");
  } finally { await tools.close(); }
});

test("a subagent's request too long to check whole, or hiding a blocked command in JSON escapes, is denied, never allowed", async () => {
  const w = world();
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "implementer", task: "x" }));
    const decisions = [{ id: "allow", kind: "allow_once" }, { id: "deny", kind: "reject_once" }];
    // As AO's upstream reads them: an MCP tool's arguments as JSON cut at 1500 bytes, a command at 4000.
    const cut = (text, bytes) => Buffer.from(text).subarray(0, bytes).toString();
    w.sessions.set(id, { turnState: "running", approvals: [
      { approval_id: "e1", kind: "permission", tool: "mcp__coding-tools__run_command", toolInput: JSON.stringify({ cmd: "cd app\ngit push origin main" }), decisions },
      { approval_id: "l1", kind: "permission", tool: "mcp__coding-tools__run_command",
        toolInput: cut(JSON.stringify({ cmd: `echo ${"a".repeat(1600)} && git push origin main` }), 1500), decisions },
      { approval_id: "l2", kind: "command", tool: "Bash", command: cut(`${"echo ok; ".repeat(450)}rm -rf ~/`, 4000), decisions },
      { approval_id: "s1", kind: "command", tool: "Bash", command: "npm test", decisions },
    ] });
    parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.deepEqual(w.resolved, [[id, "e1", "deny"], [id, "l1", "deny"], [id, "l2", "deny"], [id, "s1", "allow"]]);
  } finally { w.cleanup(); }
});

test("a subagent still ends at its time limit while AO is not running, and the poller then stops", async () => {
  let clock = 1_000_000, up = true;
  const timers = [];
  const w = world({ settings: { timeoutMinutes: 5 }, now: () => clock, aoUp: () => up,
    setTimer: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; } });
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "x" }));
    const polls = () => timers.filter((timer) => timer.ms === 2_000);
    assert.equal(polls().length, 1, "polled while it runs");
    up = false; // the backend stopped (or never came up) with the subagent running
    clock += 6 * 60_000;
    const tick = async () => { const timer = polls().at(-1); timers.splice(timers.indexOf(timer), 1); timer.callback(); await new Promise((resolve) => setImmediate(resolve)); };
    await tick();
    assert.equal(w.service.runs().find((run) => run.subagent_id === id).state, "timed_out", "the time limit holds without AO");
    assert.equal(polls().length, 0, "nothing left to poll: no timer is set again");
  } finally { w.cleanup(); }
});

test("starts made at the same moment cannot pass the per-chat or running-at-once limit together", async () => {
  const w = world({ settings: { maxConcurrent: 2, maxPerChat: 1 } });
  try {
    // A chat agent calls tools in parallel; AO takes a moment to create each session.
    const spawn = w.harness.spawn;
    w.harness.spawn = async (input) => { await new Promise((resolve) => setTimeout(resolve, 20)); return spawn(input); };
    const chat = await Promise.all(["one", "two", "three"].map((task) => w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task })));
    assert.equal(chat.filter((result) => !result.isError).length, 1, "one per chat");
    assert.match(chat.find((result) => result.isError).content[0].text, /limit per chat/);
    const others = await Promise.all(["chat-2", "chat-3", "chat-4"].map((parent) => w.service.call(parent, "ws-1", "subagent_start", { agent: "explorer", task: "x" })));
    assert.equal(others.filter((result) => !result.isError).length, 1, "two running at once in all");
    assert.match(others.find((result) => result.isError).content[0].text, /2 subagents are already running/);
    assert.equal(w.spawned.length, 2);
    // A start that failed gives its place back.
    w.harness.spawn = async () => { throw new Error("AO refused"); };
    await w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: "sub-1" });
    assert.match((await w.service.call("chat-5", "ws-1", "subagent_start", { agent: "explorer", task: "y" })).content[0].text, /AO refused/);
    w.harness.spawn = spawn;
    assert.equal(parse(await w.service.call("chat-6", "ws-1", "subagent_start", { agent: "explorer", task: "z" })).state, "starting");
  } finally { w.cleanup(); }
});
