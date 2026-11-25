"use strict";

// The chat state files saved as plain JSON (loops, schedules, wake-ups, deleted messages, MCP
// servers, goals): a file a crash tore must be kept aside, never read as "nothing saved" and then
// written over by the next save.

require("./support/temp-dirs.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLoopStore } = require("../electron/chat-loops.cjs");
const { createScheduleStore } = require("../electron/chat-schedules.cjs");
const { createWakeupStore } = require("../electron/chat-wakeups.cjs");
const { createChatEditStore } = require("../electron/chat-edits.cjs");
const { createChatMcpServers } = require("../electron/chat-mcp-servers.cjs");
const { createGoalStore, closingAnswers, roundAnswers, parseGoalCheck } = require("../electron/chat-goals.cjs");

function torn(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-chat-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  // What a power cut left of a state file on 2026-10-23: its size, all NUL bytes.
  fs.writeFileSync(file, Buffer.alloc(300));
  return { dir, file, aside: () => fs.readdirSync(dir).filter(entry => entry.startsWith(`${name}.unreadable-`)) };
}

const stores = {
  loops: { name: "chat-loops.json", make: file => createLoopStore({ file, now: () => 5000 }),
    change: store => store.set("ws", "task", { prompt: "check the deploy", minutes: 5 }) },
  schedules: { name: "chat-schedules.json", make: file => createScheduleStore({ file, now: () => 5000 }),
    change: store => store.set("ws", "task", { dueAt: 5000 + 3_600_000, message: "" }) },
  wakeups: { name: "chat-wakeups.json", make: file => createWakeupStore({ file, now: () => 5000 }),
    change: store => store.set("ws", "task", { minutes: 5, reason: "see whether CI passed", session: "s", runId: "r" }) },
  edits: { name: "chat-edits.json", make: file => createChatEditStore({ file, now: () => 5000 }),
    change: store => store.deleteMessage("ws", "task", ["run-1"]) },
};

for (const [kind, { name, make, change }] of Object.entries(stores)) {
  test(`a torn ${kind} file is kept aside, not written over by the next save`, async (t) => {
    const { file, aside } = torn(t, name);
    const store = make(file);
    assert.deepEqual(aside(), [`${name}.unreadable-5000`]);
    assert.deepEqual(fs.readFileSync(`${file}.unreadable-5000`), Buffer.alloc(300), "the torn bytes are kept");
    await change(store);
    await store.saved();
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), "the new file holds the new state");
    assert.deepEqual(fs.readFileSync(`${file}.unreadable-5000`), Buffer.alloc(300), "and the torn one stays beside it");
  });
}

test("a missing state file is no error and leaves nothing aside", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-chat-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const { name, make } of Object.values(stores)) make(path.join(dir, name));
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const how of ["preload", "load"]) {
  test(`a torn MCP servers file is kept aside before the next save (${how})`, async (t) => {
    const { file, aside } = torn(t, "chat-mcp-servers.json");
    const servers = createChatMcpServers({ filePath: file, environment: {}, npmCacheRoots: [] });
    if (how === "preload") await servers.preload();
    else assert.deepEqual(servers.list(), []);
    assert.equal(aside().length, 1);
    servers.save({ name: "docs", type: "http", url: "https://example.test/mcp" });
    await servers.saved();
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).servers.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), aside()[0])), Buffer.alloc(300));
  });
}

test("an MCP servers file that cannot be read for another reason is not moved", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-chat-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const servers = createChatMcpServers({ filePath: path.join(dir, "missing.json"), environment: {}, npmCacheRoots: [] });
  await servers.preload();
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a refused goal status leaves the goal as it was", () => {
  const goals = createGoalStore({ now: () => 1 });
  goals.set("ws", "task", "make every test pass");
  assert.throws(() => goals.update("ws", "task", { status: "finished", note: "done?" }), /Unknown goal status/);
  const goal = goals.get("ws", "task");
  assert.equal(goal.status, "active");
  assert.equal(goal.note, "");
  assert.equal(goals.update("ws", "task", { round: 2 }).round, 2, "a change that names no status keeps the current one");
});

test("a solo orchestrator that is the mission's only card is read once", () => {
  const mission = { solo: true, nodes: [{ id: "lead", role: "planner", parents: [], receipt: { answer: "answered alone" } }] };
  assert.deepEqual(closingAnswers(mission), ["answered alone"]);
  assert.deepEqual(roundAnswers(mission), ["answered alone"]);
});

test("a verdict is found when the evaluator also writes braces around it", () => {
  assert.deepEqual(parseGoalCheck('The {auth} tests pass.\n```json\n{"met": true, "reason": "40/40 pass"}\n```\nSee {log}.'),
    { met: true, stop: false, progress: true, reason: "40/40 pass" });
  assert.deepEqual(parseGoalCheck('{"met": false, "progress": false, "reason": "blocked on {approval}"}'),
    { met: false, stop: false, progress: false, reason: "blocked on {approval}" });
  assert.throws(() => parseGoalCheck("no verdict {here}"), SyntaxError);
  assert.throws(() => parseGoalCheck("nothing"), /no verdict/);
  assert.throws(() => parseGoalCheck('{"verdict": "yes"}'), /no verdict/);
});
