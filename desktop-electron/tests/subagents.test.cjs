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
function world({ settings = {}, agents = null, now = () => 1_000_000, aoUp = () => true, setTimer = undefined, models = null, teams = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-"));
  const spawned = [], resolved = [], inputs = [], interrupted = [], released = [], steered = [], sent = [], observedTurns = [];
  const sessions = new Map();
  let next = 0;
  const harness = {
    spawn: async (input) => { spawned.push(input); const id = `sub-${++next}`; sessions.set(id, { turnState: "queued", approvals: [] }); return id; },
    observe: async (id, turn) => { observedTurns.push([id, turn]); return { turnId: "t1", ...sessions.get(id) }; },
    resolveApproval: async (id, approvalId, decision) => { resolved.push([id, approvalId, decision]); },
    resolveInput: async (id, approvalId, action, content) => { inputs.push([id, approvalId, action, content]); },
    interrupt: async (id) => { interrupted.push(id); sessions.set(id, { turnState: "interrupted", status: "ready", approvals: [] }); },
    exitAgent: async (id) => { released.push(id); return { ok: true }; },
    steer: async (id, text) => { steered.push([id, text]); return { steered: true }; },
    continuable: async () => true,
    send: async (id, text) => { sent.push([id, text]); sessions.set(id, { turnState: "queued", approvals: [] }); return { turnId: `t${sent.length + 1}`, state: "queued" }; },
  };
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: async () => ({ ok: true }) });
  const service = createSubagents({
    statePath: path.join(dir, "subagents.json"),
    launchArgs: (workspaceId, route, name) => workflow.subagentLaunchArgs(workspaceId, route, name),
    harness: () => (aoUp() ? harness : null), blockedRequest: workflow.blockedRequest, recommendedAnswer: workflow.recommendedAnswer,
    ...(models ? { models } : {}), ...(teams ? { teams: () => teams } : {}),
    logger: { info() {}, warn() {} }, now, ...(setTimer ? { setTimer } : {}),
  });
  service.save({ settings: { defaultRoute: ROUTE, ...settings }, agents: agents ?? STARTERS });
  return { service, harness, sessions, spawned, resolved, inputs, interrupted, released, steered, sent, observedTurns, dir,
    cleanup: () => { service.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("stopping a parent exits only its own children even with releaseWhenDone disabled", async () => {
  const w = world({ settings: { releaseWhenDone: false } });
  try {
    const one = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" }));
    const other = parse(await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "Read two" }));
    await w.service.stopParent("chat-1");
    assert.deepEqual(w.released, [one.subagent_id]);
    assert.equal(w.service.runs().find(run => run.subagent_id === one.subagent_id).state, "stopped");
    assert.equal(w.service.runs().find(run => run.subagent_id === other.subagent_id).state, "starting");
  } finally { w.cleanup(); }
});

test("a parent stop exits a completed child's retained host without changing its report", async () => {
  const w = world({ settings: { releaseWhenDone: false } });
  try {
    const child = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" }));
    w.sessions.set(child.subagent_id, { turnState: "completed", answer: "Saved report" });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: child.subagent_id, wait_seconds: 0 });
    assert.deepEqual(w.released, []);
    await w.service.stopParent("chat-1");
    assert.deepEqual(w.released, [child.subagent_id]);
    const saved = w.service.runs()[0];
    assert.equal(saved.state, "completed");
    assert.equal(saved.report, "Saved report");
    // The chat that started it finds it by its own agent's session (the chat's Subagents tab).
    assert.equal(saved.parent, "chat-1");
    assert.equal(typeof saved.started_at, "number");
  } finally { w.cleanup(); }
});

test("a retained child already removed from AO does not prevent parent shutdown", async () => {
  const w = world({ settings: { releaseWhenDone: false } });
  try {
    const child = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" }));
    w.sessions.set(child.subagent_id, { turnState: "completed", answer: "Saved report" });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: child.subagent_id, wait_seconds: 0 });
    w.harness.exitAgent = async () => { throw new Error("Unknown session (SESSION_NOT_FOUND)"); };
    await w.service.stopParent("chat-1");
    assert.equal(w.service.runs()[0].report, "Saved report");
  } finally { w.cleanup(); }
});

test("a parent stop waits for its pending launch and ends the returned child", async () => {
  const w = world({ settings: { releaseWhenDone: false } });
  let finishLaunch;
  w.harness.spawn = () => new Promise(resolve => { finishLaunch = resolve; });
  try {
    const starting = w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" });
    const stopping = w.service.stopParent("chat-1");
    finishLaunch("late-child");
    await Promise.all([starting, stopping]);
    assert.deepEqual(w.released, ["late-child"]);
    assert.equal(w.service.runs()[0].state, "stopped");
  } finally { w.cleanup(); }
});

test("automatic release and concurrent parent stops share one pending process shutdown", async () => {
  for (const releaseWhenDone of [false, true]) {
    const w = world({ settings: { releaseWhenDone } });
    let acknowledge;
    w.harness.exitAgent = id => { w.released.push(id); return new Promise(resolve => { acknowledge = resolve; }); };
    try {
      const child = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" }));
      w.sessions.set(child.subagent_id, { turnState: "completed", answer: "Finished report" });
      await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: child.subagent_id, wait_seconds: 0 });
      const one = w.service.stopParent("chat-1"), two = w.service.stopParent("chat-1");
      await Promise.resolve(); await Promise.resolve();
      assert.deepEqual(w.released, [child.subagent_id], "only one shutdown is submitted before its acknowledgment");
      acknowledge({ ok: true });
      await Promise.all([one, two]);
      assert.equal(w.service.runs()[0].report, "Finished report");
    } finally { acknowledge?.({ ok: true }); w.cleanup(); }
  }
});

test("a parent stop releases completed child processes once while retaining their reports", async () => {
  for (const releaseWhenDone of [false, true]) {
    const w = world({ settings: { releaseWhenDone } });
    try {
      const child = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" }));
      w.sessions.set(child.subagent_id, { turnState: "completed", answer: "Verified report" });
      await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: child.subagent_id, wait_seconds: 0 });
      await Promise.resolve(); await Promise.resolve();
      assert.deepEqual(w.released, releaseWhenDone ? [child.subagent_id] : [], "completion alone follows the configured release setting");
      await w.service.stopParent("chat-1");
      await w.service.stopParent("chat-1");
      assert.deepEqual(w.released, [child.subagent_id], "an explicit parent stop releases an idle child once");
      const saved = w.service.runs().find(run => run.subagent_id === child.subagent_id);
      assert.equal(saved.state, "completed", "process shutdown preserves the finished result");
      assert.equal(saved.report, "Verified report");
    } finally { w.cleanup(); }
  }
});

test("a parent stop traverses completed children and reports a descendant exit refusal", async () => {
  const w = world({ settings: { releaseWhenDone: false } });
  try {
    const child = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read one" }));
    w.sessions.set(child.subagent_id, { turnState: "completed", answer: "Done" });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: child.subagent_id, wait_seconds: 0 });
    const grandchild = parse(await w.service.call(child.subagent_id, "ws-1", "subagent_start", { agent: "explorer", task: "Read two" }));
    w.harness.exitAgent = async id => { w.released.push(id); return { ok: false }; };
    await assert.rejects(w.service.stopParent("chat-1"), /shutdown is unconfirmed/);
    assert.deepEqual(w.released, [child.subagent_id, grandchild.subagent_id]);
    assert.equal(w.service.runs().find(run => run.subagent_id === grandchild.subagent_id).state, "starting");
  } finally { w.cleanup(); }
});

test("the saved settings and subagents are validated and kept", () => {
  const w = world();
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(w.dir, "subagents.json"), "utf8"));
    assert.deepEqual(saved.agents.map((agent) => agent.id), ["explorer", "implementer", "reviewer"], "the starters until the user changes them");
    assert.equal(saved.settings.maxConcurrent, 3);
    assert.deepEqual(saved.settings.defaultRoute, ROUTE);
    // As many as the person wants, up to 100, globally and per chat (the cap was 10).
    const clamped = cleanConfig({ settings: { maxConcurrent: 500, maxPerChat: 40, timeoutMinutes: 0, permission: "nonsense" }, agents: [] }).settings;
    assert.equal(clamped.maxConcurrent, 100);
    assert.equal(clamped.maxPerChat, 40);
    assert.equal(clamped.timeoutMinutes, 1);
    assert.equal(clamped.permission, "auto");
    assert.throws(() => cleanConfig({ agents: [{ name: "a" }, { name: "A" }] }), /share the id/);
    assert.throws(() => cleanConfig({ agents: [{ name: "x", route: { harness_id: "codex-native", model: "m" } }] }), /Agent Orchestrator agent/);
    assert.throws(() => cleanConfig({ agents: [{ name: "x", route: { harness_id: "ao:codex", model: "cpa/chatgpt-web/high" } }] }), /WebGPT/);
    assert.throws(() => cleanConfig({ agents: [{ name: "x", route: { harness_id: "ao:codex", model: "m", effort: "turbo" } }] }), /effort/);
  } finally { w.cleanup(); }
});

test("a subagent preserves the model's none effort when saved and launched", async () => {
  const route = { harness_id: "ao:claude-code", model: "cpa/cline-pass/deepseek-v4.1-flash", effort: "none" };
  const w = world({ settings: { defaultRoute: route } });
  try {
    assert.deepEqual(w.service.config().settings.defaultRoute, route);
    const saved = JSON.parse(fs.readFileSync(path.join(w.dir, "subagents.json"), "utf8"));
    assert.equal(saved.settings.defaultRoute.effort, "none");
    const started = await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Read the source" });
    assert.equal(started.isError, false);
    // Claude Code sends the effort in the request body (#498), not as a "(none)" model suffix.
    assert.equal(w.spawned[0].gateway.model, "cline-pass/deepseek-v4.1-flash");
    assert.equal(w.spawned[0].effort, "none");
    assert.equal(w.service.config().settings.defaultRoute.effort, "none");
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

test("a failed approval answer retries on a fresh pending observation and confirmed answers stay deduplicated", async () => {
  const w = world();
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    const resolve = w.harness.resolveApproval;
    let attempts = 0;
    w.harness.resolveApproval = async (...args) => { if (++attempts === 1) throw new Error("temporary transport failure"); return resolve(...args); };
    w.sessions.set(id, { turnState: "running", approvals: [{ approval_id: "same-request", kind: "command", command: "npm test",
      decisions: [{ id: "allow", kind: "allow_once" }] }] });
    for (let poll = 0; poll < 3; poll++) await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.equal(attempts, 2, "retry the failed send, then keep the acknowledged answer");
    assert.deepEqual(w.resolved, [[id, "same-request", "allow"]]);
  } finally { w.cleanup(); }
});

test("a question retries after both answer and fallback failed", async () => {
  const w = world();
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    const resolve = w.harness.resolveInput;
    let failing = true, attempts = 0;
    w.harness.resolveInput = async (...args) => { attempts++; if (failing) throw new Error("temporary transport failure"); return resolve(...args); };
    w.sessions.set(id, { turnState: "running", approvals: [{ approval_id: "question-1", kind: "question", fields: [] }] });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    failing = false;
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.equal(attempts, 3);
    assert.equal(w.inputs.length, 1);
  } finally { w.cleanup(); }
});

test("a question fallback cannot be sent after its subagent was stopped", async () => {
  const w = world({ settings: { releaseWhenDone: false } });
  let rejectAnswer, answerStarted, pending;
  const answer = new Promise((_resolve, reject) => { rejectAnswer = reject; });
  const entered = new Promise(resolve => { answerStarted = resolve; });
  let attempts = 0;
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    const resolve = w.harness.resolveInput;
    w.harness.resolveInput = async (...args) => { if (++attempts === 1) { answerStarted(); return answer; } return resolve(...args); };
    w.sessions.set(id, { turnState: "running", approvals: [{ approval_id: "q", kind: "question", fields: [] }] });
    pending = w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    await entered;
    await w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: id });
    rejectAnswer(new Error("answer transport ended with the stop"));
    await pending;
    assert.equal(attempts, 1, "do not send the fallback decline after Stop");
    assert.deepEqual(w.inputs, []);
  } finally {
    rejectAnswer(new Error("fixture cleanup"));
    await pending;
    w.cleanup();
  }
});

test("approval deduplication is scoped to the subagent session", async () => {
  const w = world();
  try {
    const ids = [];
    for (const parent of ["chat-1", "chat-2"]) {
      const id = parse(await w.service.call(parent, "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
      ids.push(id);
      w.sessions.set(id, { turnState: "running", approvals: [{ approval_id: "request-1", kind: "command", command: "npm test",
        decisions: [{ id: "allow", kind: "allow_once" }] }] });
      await w.service.call(parent, "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    }
    assert.deepEqual(w.resolved, ids.map(id => [id, "request-1", "allow"]));
  } finally { w.cleanup(); }
});



test("an unacknowledged Stop retries after transport recovery without permitting new work", async () => {
  const w = world({ settings: { maxConcurrent: 1, releaseWhenDone: false } });
  let attempts = 0;
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    const approval = { approval_id: "blocked-while-stopping", kind: "command", command: "npm test", decisions: [{ id: "allow", kind: "allow_once" }] };
    w.sessions.set(id, { turnState: "running", status: "working", approvals: [approval] });
    w.harness.interrupt = async () => { if (++attempts === 1) throw new Error("temporary interrupt transport failure"); };
    assert.equal((await w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: id })).isError, true);
    for (let i = 0; i < 3; i++) await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.equal(attempts, 2, "the failed signal is retried, while its acknowledged retry is not repeatedly sent");
    assert.deepEqual(w.resolved, []);
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "overlap" })).isError, true);
    w.sessions.set(id, { turnState: "interrupted", status: "ready", approvals: [] });
    assert.equal(parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 })).state, "stopped");
  } finally { w.cleanup(); }
});

test("an interrupt ACK keeps capacity and suppresses approvals until terminal observation", async () => {
  const w = world({ settings: { maxConcurrent: 1, releaseWhenDone: false } });
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    const approval = { approval_id: "pending-after-stop", kind: "command", command: "npm test", decisions: [{ id: "allow", kind: "allow_once" }] };
    w.sessions.set(id, { turnState: "running", status: "working", approvals: [approval] });
    w.harness.interrupt = async () => { w.interrupted.push(id); }; // The HTTP 204 acknowledges only cancellation.
    const stop = await w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: id });
    assert.equal(stop.isError, true, "Stop must describe its unconfirmed settlement");
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "overlap" })).isError, true);
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.deepEqual(w.resolved, [], "pending cancellation never resumes automatic approvals");
    w.sessions.set(id, { turnState: "interrupted", status: "working", approvals: [approval] });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "still overlap" })).isError, true,
      "a terminal turn alone cannot free a busy agent");
    w.sessions.set(id, { turnState: "interrupted", status: "ready", approvals: [] });
    const done = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.equal(done.state, "stopped");
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "next" })).isError, false);
  } finally { w.cleanup(); }
});

test("repeated unreadable observations keep the uncertain agent's capacity until it settles", async () => {
  const w = world({ settings: { maxConcurrent: 1, releaseWhenDone: false } });
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    w.harness.observe = async () => { throw new Error("temporary status transport failure"); };
    w.harness.interrupt = async () => { w.interrupted.push(id); };
    for (let i = 0; i < 5; i++) await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "overlap" })).isError, true,
      "five read failures are no evidence of a terminated agent");
    assert.deepEqual(w.released, []);
    w.harness.observe = async () => ({ turnState: "interrupted", status: "ready", approvals: [] });
    const done = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.equal(done.state, "failed");
    assert.match(done.error, /session cannot be read/);
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "next" })).isError, false);
  } finally { w.cleanup(); }
});

test("normal completion also retains capacity while the session remains busy", async () => {
  const w = world({ settings: { maxConcurrent: 1, releaseWhenDone: false } });
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    w.sessions.set(id, { turnState: "completed", status: "working", answer: "done", approvals: [] });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "overlap" })).isError, true);
    w.sessions.set(id, { turnState: "completed", status: "ready", answer: "done", approvals: [] });
    assert.equal(parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 })).state, "completed");
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "next" })).isError, false);
  } finally { w.cleanup(); }
});

test("a failed or unavailable interrupt keeps the subagent running and its slot reserved", async () => {
  for (const unavailable of [false, true]) {
    let up = true;
    const w = world({ settings: { maxConcurrent: 1, releaseWhenDone: false }, aoUp: () => up });
    try {
      const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
      w.sessions.set(id, { turnState: "running", approvals: [] });
      await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
      if (unavailable) up = false;
      else w.harness.interrupt = async () => { throw new Error("temporary transport failure"); };
      const stop = await w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: id });
      assert.equal(stop.isError, true);
      assert.equal(w.service.runs()[0].state, "running");
      assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "another" })).isError, true);
      assert.deepEqual(w.released, [], "a failed stop must not release the live agent");
    } finally { up = true; w.cleanup(); }
  }
});

test("concurrent stops share the interrupt and a late observation cannot approve work after stopping starts", async () => {
  const w = world({ settings: { maxConcurrent: 1, releaseWhenDone: false } });
  let releaseObservation, observationStarted, releaseInterrupt, interruptStarted;
  const observation = new Promise(resolve => { releaseObservation = resolve; });
  const observed = new Promise(resolve => { observationStarted = resolve; });
  const interrupt = new Promise(resolve => { releaseInterrupt = resolve; });
  const interruptEntered = new Promise(resolve => { interruptStarted = resolve; });
  let pending, first, second, attempts = 0;
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    w.harness.observe = async () => { observationStarted(); return observation; };
    w.harness.interrupt = async () => { attempts++; interruptStarted(); await interrupt; };
    pending = w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    await observed;
    first = w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: id });
    second = w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: id });
    await interruptEntered;
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "another" })).isError, true);
    releaseObservation({ turnState: "running", approvals: [{ approval_id: "late", kind: "command", command: "npm test",
      decisions: [{ id: "allow", kind: "allow_once" }] }] });
    await pending;
    assert.deepEqual(w.resolved, [], "a stale poll cannot answer another request after Stop");
    assert.equal(attempts, 1, "both callers await the same stop");
    w.harness.observe = async () => ({ turnState: "interrupted", status: "ready", approvals: [] });
    releaseInterrupt();
    assert.equal(parse(await first).state, "stopped");
    assert.equal(parse(await second).state, "stopped");
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "another" })).isError, false);
  } finally {
    releaseObservation({ turnState: "interrupted", approvals: [] }); releaseInterrupt();
    await Promise.allSettled([pending, first, second].filter(Boolean));
    w.cleanup();
  }
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

test("a timed-out subagent keeps its capacity and poller until AO confirms settlement", async () => {
  let clock = 1_000_000, up = true;
  const timers = [];
  const w = world({ settings: { timeoutMinutes: 5, maxConcurrent: 1 }, now: () => clock, aoUp: () => up,
    setTimer: (callback, ms) => { const timer = { callback, ms, unref() {} }; timers.push(timer); return timer; } });
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "x" }));
    const polls = () => timers.filter((timer) => timer.ms === 2_000);
    assert.equal(polls().length, 1, "polled while it runs");
    up = false; // the backend stopped (or never came up) with the subagent running
    clock += 6 * 60_000;
    const tick = async () => { const timer = polls().at(-1); timers.splice(timers.indexOf(timer), 1); timer.callback(); await new Promise((resolve) => setImmediate(resolve)); };
    await tick();
    const pending = w.service.runs().find((run) => run.subagent_id === id);
    assert.match(pending.error, /Stopped after 5 minutes/);
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "overlap" })).isError, true,
      "the time limit requests cancellation; an offline backend cannot confirm that it ended");
    assert.equal(polls().length, 1, "the uncertain agent keeps being observed");
    up = true;
    w.sessions.set(id, { turnState: "running", status: "working", approvals: [] });
    await tick();
    assert.deepEqual(w.interrupted, [id], "recovery retries cancellation instead of passively waiting forever");
    assert.equal(w.service.runs().find((run) => run.subagent_id === id).state, "timed_out");
    assert.equal(polls().length, 0, "confirmed settlement ends polling");
  } finally { w.cleanup(); }
});

test("a subagent whose AO session ended mid-turn fails at once instead of running until its time limit", async () => {
  const w = world({ settings: { timeoutMinutes: 240 } });
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "x" }));
    // Killed in AO (or its agent died): AO reports the session exited while the turn it left still reads "running".
    w.sessions.set(id, { status: "terminated", exited: true, turnState: "running", approvals: [] });
    const result = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.equal(result.state, "failed");
    assert.match(result.error, /session ended/);
  } finally { w.cleanup(); }
});

test("the app's chat tools and subagents read the safety rules of the workflow running now", () => {
  // Both are created once, inside the first backend start, and outlive it. A closure over that
  // start's `const agentOrchestratorWorkflow` (declared further down) threw "Cannot access before
  // initialization" for good when that start failed before reaching it (AO not starting), and
  // otherwise kept a disposed backend's rules after every backend restart.
  const main = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const once = main.slice(main.indexOf("    if (!subagentsService) {"), main.indexOf("    const createCodingToolsAppsHost"));
  assert.ok(once.includes("createChatAgentTools({") && once.includes("createSubagents({"));
  assert.doesNotMatch(once, /\bagentOrchestratorWorkflow\b/);
  // A command RTK rewrote is judged as the command it wraps (rtk.unwrap), still by the running workflow.
  assert.match(once, /routineCommand: \(command\) => missionWorkflowRuntime\?\.routineCommand\?\.\(rtk\.unwrap\(command\)\) \?\? null/);
  assert.match(once, /blockedCommand: \(text\) => missionWorkflowRuntime\?\.blockedRequest\?\.\(text\) \?\? true/);
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

test("a settled turn keeps stopping state and capacity until host shutdown is acknowledged", async () => {
  const timers = [];
  const w = world({ settings: { releaseWhenDone: false, maxConcurrent: 1 },
    setTimer: callback => { timers.push(callback); return { unref() {} }; } });
  let acknowledge, started;
  const hostStarted = new Promise(resolve => { started = resolve; });
  w.harness.exitAgent = () => { started(); return new Promise(resolve => { acknowledge = resolve; }); };
  try {
    const id = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "read" })).subagent_id;
    const stopping = w.service.stopParent("chat-1");
    stopping.catch(() => undefined);
    await hostStarted;
    timers.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.service.runs()[0].stopping, true);
    assert.notEqual(w.service.runs()[0].state, "stopped", "polling cannot finish an unacknowledged host exit");
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "overlap" })).isError, true);
    acknowledge({ ok: false });
    await assert.rejects(stopping, /shutdown is unconfirmed/);
    assert.notEqual(w.service.runs()[0].state, "stopped");
    assert.match(w.service.runs()[0].error, /shutdown is unconfirmed/);
  } finally { acknowledge?.({ ok: false }); w.cleanup(); }
});

test("a subagent whose model keeps refusing requests stops at the third 429 and tells its chat why", async () => {
  // Seen live: an explorer on Gemini through Antigravity got "Resource has been exhausted" (429)
  // for 20 minutes while Claude Code backed off, and the chat that started it waited on its report.
  const w = world();
  try {
    const started = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "Map the training data" }));
    const retrying = (attempt, status = 429) => ({ turnState: "running", status: "working", approvals: [], timeline: [
      { id: "r", kind: "system", status: "running", text: `Retrying Claude, attempt ${attempt} of 10. API error ${status}. Trying again in 20s.` }] });
    w.sessions.set(started.subagent_id, retrying(2));
    let result = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 }));
    assert.ok(["starting", "running"].includes(result.state), "two refusals are left to Claude Code's own retries");
    w.sessions.set(started.subagent_id, retrying(3, 503));
    result = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 }));
    assert.ok(["starting", "running"].includes(result.state), "a failing service (5xx) is not a refusal");
    w.sessions.set(started.subagent_id, retrying(3));
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 });
    assert.deepEqual(w.interrupted, [started.subagent_id], "it is stopped");
    result = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 }));
    assert.match(String(result.error ?? ""), /keeps refusing requests \(API error 429, attempt 3 of 10\)/);
  } finally { w.cleanup(); }
});

// Claude Code's catalog as the workflow's models({ harness: "ao:claude-code" }) returns it.
const CATALOG = {
  ok: true, harness: "ao:claude-code", models: ["cpa/glm-5", "cpa/fixed-model"],
  capabilities: {
    "cpa/glm-5": { efforts: ["low", "high"], contextLimit: 200000, contextWindow: { min: 4096, max: 200000, kind: "context" } },
    "cpa/fixed-model": { efforts: [], effortReason: "CPA did not advertise reasoning levels for this model.", contextReason: "No setter." },
  },
  unavailable: { "cpa/retired": "nobody is signed in to its provider" },
};

test("a chat agent picks a subagent's model, effort and window, and it always runs on Claude Code", async () => {
  const w = world({ settings: { defaultRoute: { harness_id: "ao:codex", model: "gpt-6" } }, models: async () => CATALOG });
  try {
    const listed = parse(await w.service.call("chat-1", "ws-1", "subagent_models", {}));
    assert.match(listed.harness, /Claude Code/);
    assert.deepEqual(listed.models[0], { id: "glm-5", efforts: ["low", "high"], context_window: { min: 4096, max: 200000 }, context_limit: 200000 });
    const started = parse(await w.service.call("chat-1", "ws-1", "subagent_start",
      { agent: "explorer", task: "Map the code", model: "glm-5", effort: "high", context_window: 120000 }));
    assert.equal(started.model, "glm-5");
    assert.equal(w.spawned[0].agent, "claude-code", "the saved Codex route is not used once a model is picked");
    assert.deepEqual(w.spawned[0].gateway, { provider: "cpa", model: "glm-5" });
    assert.equal(w.spawned[0].effort, "high");
    assert.equal(w.spawned[0].contextWindow, 120000);
    assert.match(w.spawned[0].prompt, /read-only explorer/, "the saved subagent's instructions still apply");
    const refuse = async (args, pattern) => {
      const result = await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "x", ...args });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, pattern);
    };
    await refuse({ model: "retired" }, /not offered to Claude Code \(nobody is signed in/);
    await refuse({ model: "glm-5", effort: "max" }, /offers the efforts low, high/);
    await refuse({ model: "fixed-model", effort: "low" }, /takes no reasoning effort/);
    await refuse({ model: "glm-5", context_window: 500000 }, /from 4096 to 200000/);
    await refuse({ model: "fixed-model", context_window: 100000 }, /takes no context window/);
    await refuse({ effort: "low" }, /Name the model/);
    await refuse({ team: "squad", model: "glm-5" }, /own roles and models/);
    // With no saved subagent: the task alone, on the picked model.
    const custom = parse(await w.service.call("chat-3", "ws-1", "subagent_start", { task: "Count the tests", model: "cpa/glm-5" }));
    assert.equal(custom.agent, "custom");
    assert.doesNotMatch(w.spawned[1].prompt, /read-only explorer/);
    assert.equal(w.spawned.length, 2);
  } finally { w.cleanup(); }
});

test("an effort or window alone keeps a saved Claude Code route's model; an unreadable catalog leaves the launch to check", async () => {
  const w = world({ settings: { defaultRoute: { harness_id: "ao:claude-code", model: "cpa/glm-5", effort: "low" } }, models: async () => { throw new Error("CPA down"); } });
  try {
    await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "x", context_window: 64000 });
    assert.deepEqual(w.spawned[0].gateway, { provider: "cpa", model: "glm-5" });
    assert.equal(w.spawned[0].effort, "low", "the saved effort is kept");
    assert.equal(w.spawned[0].contextWindow, 64000);
    assert.equal((await w.service.call("chat-1", "ws-1", "subagent_models", {})).isError, true);
  } finally { w.cleanup(); }
});

test("a chat agent steers a working subagent and gives a finished one its next task in the same session", async () => {
  const w = world();
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "implementer", task: "Add a test" }));
    const early = await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: id, message: "Also lint" });
    assert.match(early.content[0].text, /not begun its turn/);
    w.sessions.set(id, { turnState: "running", status: "working", approvals: [] });
    const steered = parse(await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: id, message: "Use node:test" }));
    assert.equal(steered.delivered, "steered");
    assert.deepEqual(w.steered, [[id, "Use node:test"]]);

    w.sessions.set(id, { turnState: "completed", status: "ready", answer: "Added tests/a.test.cjs", approvals: [] });
    assert.equal(parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 })).state, "completed");
    assert.deepEqual(w.released, [id]);
    const next = parse(await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: id, message: "Now run it on CI" }));
    assert.equal(next.delivered, "new_turn");
    assert.equal(next.previous_report, "Added tests/a.test.cjs");
    assert.equal(next.state, "starting");
    assert.equal(next.turns, 2);
    assert.deepEqual(w.sent, [[id, "Now run it on CI"]]);
    // Its next report is read from the new turn, never the finished one.
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 });
    assert.deepEqual(w.observedTurns.at(-1), [id, "t2"]);
    w.sessions.set(id, { turnState: "completed", status: "ready", answer: "CI green", approvals: [] });
    const done = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: id, wait_seconds: 0 }));
    assert.equal(done.report, "CI green");
    assert.deepEqual(w.released, [id, id], "released again once the follow-up is done");

    w.harness.continuable = async () => false;
    const gone = await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: id, message: "More" });
    assert.match(gone.content[0].text, /can no longer continue/);
    assert.equal((await w.service.call("chat-2", "ws-1", "subagent_message", { subagent_id: id, message: "x" })).isError, true, "another chat cannot message it");
  } finally { w.cleanup(); }
});

test("a message counts toward the limits, and a steer that arrives as the turn ends collects its report first", async () => {
  const w = world({ settings: { maxConcurrent: 1 } });
  try {
    const { subagent_id: first } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "one" }));
    w.sessions.set(first, { turnState: "running", status: "working", approvals: [] });
    await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: first, wait_seconds: 0 });
    w.harness.steer = async () => { w.sessions.set(first, { turnState: "completed", status: "ready", answer: "Found it", approvals: [] }); return { steered: false }; };
    const late = parse(await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: first, message: "and the tests" }));
    assert.equal(late.delivered, "new_turn");
    assert.equal(late.previous_report, "Found it");
    const blocked = await w.service.call("chat-2", "ws-1", "subagent_start", { agent: "explorer", task: "two" });
    assert.match(blocked.content[0].text, /already running/, "the resumed subagent holds its place again");
  } finally { w.cleanup(); }
});

test("subagent_inspect shows a subagent's latest steps, idle time, running tool and waiting requests", async () => {
  let clock = 1_000_000;
  const w = world({ now: () => clock });
  try {
    const { subagent_id: id } = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { agent: "explorer", task: "x" }));
    w.sessions.set(id, { turnState: "running", status: "working", lastActivityAt: clock - 30_000, toolSince: clock - 12_000, liveOutput: "Looking at src/",
      approvals: [{ approval_id: "a", kind: "command", tool: "Bash", command: "git push origin main", decisions: [] }],
      timeline: [
        { kind: "reasoning", status: "completed", text: "Plan:\n  read the router" },
        { kind: "edit", status: "completed", label: "Edited router.ts +2 -1", text: "src/router.ts", files: [{ path: "src/router.ts" }] },
        { kind: "command", status: "running", text: "npm test" },
      ] });
    const seen = parse(await w.service.call("chat-1", "ws-1", "subagent_inspect", { subagent_id: id, items: 2 }));
    assert.equal(seen.turn_state, "running");
    assert.equal(seen.last_activity_seconds_ago, 30);
    assert.equal(seen.tool_running_seconds, 12);
    assert.deepEqual(seen.pending_requests, [{ kind: "command", tool: "Bash", command: "git push origin main" }]);
    assert.equal(seen.live_output, "Looking at src/");
    assert.deepEqual(seen.timeline, [
      { kind: "edit", status: "completed", label: "Edited router.ts +2 -1", text: "src/router.ts", files: ["src/router.ts"] },
      { kind: "command", status: "running", text: "npm test" },
    ]);
  } finally { w.cleanup(); }
});

/** A fake of the workflow's subagentTeams over runs the test settles. */
function teamOwner() {
  const missions = new Map(), started = [], stopped = [], followUps = [];
  let next = 0;
  return { missions, started, stopped, followUps,
    list: async () => [{ id: "t1", name: "Squad", revision: 2, roles: [{ name: "Lead", model: "glm-5" }, { name: "Builder", model: "glm-5" }] }],
    start: async (input) => { started.push(input); const runId = `run-${++next}`; missions.set(runId, { settled: false, roles: [], answers: [] }); return { taskId: "task-1", runId }; },
    followUp: async (input) => { followUps.push(input); const runId = `run-${++next}`; missions.set(runId, { settled: false, roles: [], answers: [] }); return { runId }; },
    state: async ({ runId }) => missions.get(runId),
    stop: async ({ runId }) => { stopped.push(runId); missions.set(runId, { ...missions.get(runId), settled: true, cancelled: true }); return { ok: true }; },
  };
}

test("a saved team runs as one subagent: listed, started as its own chat, reported, followed up and stopped", async () => {
  const owner = teamOwner();
  const w = world({ teams: owner });
  try {
    const listed = parse(await w.service.call("chat-1", "ws-1", "subagent_list", {}));
    assert.deepEqual(listed.teams, [{ id: "t1", name: "Squad", roles: [{ name: "Lead", model: "glm-5" }, { name: "Builder", model: "glm-5" }] }]);
    const started = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { team: "squad", task: "Ship the login page" }));
    assert.equal(started.team, "t1");
    assert.equal(started.name, "Squad");
    assert.equal(owner.started[0].teamId, "t1");
    assert.equal(owner.started[0].title, "Subagent team · Squad");
    assert.match(owner.started[0].message, /working as a subagent[\s\S]*Task:\nShip the login page$/);
    assert.equal(w.spawned.length, 0, "the team's own run starts its agents");

    const running = await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: started.subagent_id, message: "x" });
    assert.match(running.content[0].text, /only once it has finished/);
    owner.missions.set("run-1", { settled: false, roles: [{ name: "Lead", state: "finished" }, { name: "Builder", state: "running" }], answers: ["Plan done"], detail: "" });
    const seen = parse(await w.service.call("chat-1", "ws-1", "subagent_inspect", { subagent_id: started.subagent_id }));
    assert.equal(seen.state, "running");
    assert.deepEqual(seen.roles.map(role => role.state), ["finished", "running"]);
    assert.deepEqual(seen.answers_so_far, ["Plan done"]);

    owner.missions.set("run-1", { settled: true, cancelled: false, failed: false, roles: [], answers: ["Login page shipped", "Tests pass"] });
    const done = parse(await w.service.call("chat-1", "ws-1", "subagent_result", { subagent_id: started.subagent_id, wait_seconds: 0 }));
    assert.equal(done.state, "completed");
    assert.equal(done.report, "Login page shipped\n\n---\n\nTests pass");

    const again = parse(await w.service.call("chat-1", "ws-1", "subagent_message", { subagent_id: started.subagent_id, message: "Add a logout button" }));
    assert.equal(again.delivered, "new_turn");
    assert.equal(again.previous_report, "Login page shipped\n\n---\n\nTests pass");
    assert.deepEqual(owner.followUps, [{ workspaceId: "ws-1", taskId: "task-1", teamId: "t1", message: "Add a logout button" }]);
    owner.missions.set("run-2", { settled: false, roles: [], answers: [] });
    const halted = parse(await w.service.call("chat-1", "ws-1", "subagent_stop", { subagent_id: started.subagent_id }));
    assert.deepEqual(owner.stopped, ["run-2"], "the follow-up's own run is stopped");
    assert.equal(halted.state, "stopped");
    assert.match((await w.service.call("chat-1", "ws-1", "subagent_start", { team: "nobody", task: "x" })).content[0].text, /No saved team/);
  } finally { w.cleanup(); }
});

test("a parent stop also stops its team subagents, and a failed team reports why", async () => {
  const owner = teamOwner();
  const w = world({ teams: owner });
  try {
    const one = parse(await w.service.call("chat-1", "ws-1", "subagent_start", { team: "t1", task: "a" }));
    await w.service.stopParent("chat-1");
    assert.deepEqual(owner.stopped, ["run-1"]);
    assert.equal(w.service.runs().find(run => run.subagent_id === one.subagent_id).state, "stopped");
    const two = parse(await w.service.call("chat-2", "ws-1", "subagent_start", { team: "t1", task: "b" }));
    owner.missions.set("run-2", { settled: true, failed: true, detail: "Review contains failed or blocked work", roles: [], answers: ["Half done"] });
    const failed = parse(await w.service.call("chat-2", "ws-1", "subagent_result", { subagent_id: two.subagent_id, wait_seconds: 0 }));
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /failed or blocked work/);
    assert.equal(failed.report, "Half done");
  } finally { w.cleanup(); }
});

test("the workflow offers saved teams with a model for every role and reads a team run's closing answers", async () => {
  const reads = [];
  const workflow = createAgentOrchestratorWorkflow({ requestHeadless: async (endpoint, body) => {
    reads.push([endpoint, body]);
    if (endpoint !== "/api/v1/ao/read") return { ok: true };
    return { ok: true, teams: [
      { id: "t1", name: "Squad", revision: 4, nodes: [{ role: "planner", settings: { name: "Lead" }, route: { model: "cpa/glm-5" } }] },
      { id: "t2", name: "Unset", revision: 1, nodes: [{ role: "worker", route: { model: "default" } }] },
    ], runs: [{ id: "run-1", workspace_id: "ws-1", nodes: [
      { id: "p", role: "planner", state: "finished", parents: [], receipt: { answer: "Plan" } },
      { id: "w", role: "worker", state: "finished", parents: ["p"], settings: { name: "Builder" }, receipt: { answer: "Built it" } },
    ] }] };
  } });
  const teams = await workflow.subagentTeams.list("ws-1");
  assert.deepEqual(teams, [{ id: "t1", name: "Squad", revision: 4, roles: [{ name: "Lead", model: "glm-5" }] }], "a team with an unset model is not offered");
  const state = await workflow.subagentTeams.state({ workspaceId: "ws-1", runId: "run-1" });
  assert.equal(state.settled, true);
  assert.equal(state.failed, false);
  assert.deepEqual(state.answers, ["Built it"]);
  assert.deepEqual(state.roles.map(role => [role.name, role.state]), [["planner", "finished"], ["Builder", "finished"]]);
  workflow.dispose();
});