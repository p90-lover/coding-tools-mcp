const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
const chat = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: chat });
const plain = (value) => JSON.parse(JSON.stringify(value));

const node = (id, role, state, extra = {}) => ({ id, role, state, x: 0, ...extra });
const run = (id, taskId, nodes, extra = {}) => ({ id, project_id: taskId, cancelled: false, nodes, ...extra });

test("the task description splits into the first message and timestamped follow-ups", () => {
  const description = "fix the email dots\n\nFollow-up (2026-09-30 04:10 UTC):\nalso the time zone\n\nFollow-up (2026-09-30 05:00 UTC):\nand tests";
  assert.deepEqual(plain(chat.chatMessagesFromDescription(description)), [
    { text: "fix the email dots" },
    { stamp: "2026-09-30 04:10", text: "also the time zone" },
    { stamp: "2026-09-30 05:00", text: "and tests" },
  ]);
  assert.deepEqual(plain(chat.chatMessagesFromDescription("")), []);
});

test("chats group runs by task, newest first, titled 'New task' when the task is unnamed", () => {
  const runs = [
    run("r1", "a", [node("p", "planner", "finished")]),
    run("r2", "b", [node("p", "planner", "running")]),
    run("r3", "a", [node("p", "planner", "pending")]),
  ];
  const list = plain(chat.chatList(runs, [{ id: "b", title: "Fix auth" }]));
  assert.deepEqual(list.map((entry) => [entry.taskId, entry.title, entry.latestRunId, entry.status]), [
    ["a", "New task", "r3", "queued"],
    ["b", "Fix auth", "r2", "running"],
  ]);
  assert.deepEqual(list[0].runIds, ["r1", "r3"]);
});

test("chat status and whether a follow-up can be sent", () => {
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "held")])), "attention");
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "finished")], { paused: true })), "paused");
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "running")], { cancelled: true })), "stopped");
  assert.equal(chat.chatRunStatus(run("r", "t", [node("p", "planner", "finished"), node("w", "worker", "cancelled")])), "done");
  assert.equal(chat.chatAcceptsMessage("done"), true);
  assert.equal(chat.chatAcceptsMessage("stopped"), true);
  assert.equal(chat.chatAcceptsMessage("running"), false);
  assert.equal(chat.chatAcceptsMessage(undefined), true, "a new chat accepts its first message");
  // A stuck run (never started, held, paused) no longer locks an old chat; only real work does.
  for (const status of ["queued", "attention", "paused"]) {
    assert.equal(chat.chatAcceptsMessage(status), true, status);
    assert.equal(chat.chatAcceptsMessage(status, true), false, `${status} while working`);
    assert.equal(chat.chatRunOpen(status), true, `${status} can be stopped`);
  }
  assert.equal(chat.chatRunOpen("done"), false);
  assert.equal(chat.chatRunOpen("stopped"), false);
});

test("the transcript pairs each message with that run's replies in orchestration order", () => {
  const runs = [
    run("r1", "t", [
      node("rev", "reviewer", "finished", { receipt: { answer: "APPROVED — looks good", verdict: "APPROVED" } }),
      node("w2", "worker", "finished", { x: 2, settings: { name: "Tests" }, receipt: { answer: "added tests" } }),
      node("w1", "worker", "finished", { x: 1, receipt: { answer: "fixed it" } }),
      node("p", "planner", "finished", { receipt: { answer: "two steps" } }),
    ]),
    run("r2", "t", [node("p", "planner", "running"), node("w", "worker", "pending")]),
  ];
  const description = "fix it\n\nFollow-up (2026-09-30 04:10 UTC):\nnow docs";
  const transcript = plain(chat.chatTranscript(runs, description));
  assert.deepEqual(transcript.map((message) => [message.kind, message.name ?? "", message.text]), [
    ["user", "", "fix it"],
    ["agent", "Orchestrator", "two steps"],
    ["agent", "Worker", "fixed it"],
    ["agent", "Tests", "added tests"],
    ["agent", "Main reviewer", "APPROVED — looks good"],
    ["user", "", "now docs"],
    ["status", "", "Orchestrator is working…"],
  ]);
  assert.equal(transcript[4].tone, "verdict");
  assert.equal(transcript[4].verdict, "APPROVED");
  assert.equal(transcript[5].stamp, "2026-09-30 04:10");
});

test("errors, holds, stops and a just-sent message all show in the transcript", () => {
  const runs = [run("r1", "t", [
    node("p", "planner", "finished", { receipt: { error: "model unavailable" } }),
    node("w", "worker", "held"),
  ], { cancelled: true })];
  const transcript = plain(chat.chatTranscript(runs, "go\n\nFollow-up (2026-09-30 06:00 UTC):\nretry"));
  assert.deepEqual(transcript.map((message) => [message.kind, message.text]), [
    ["user", "go"],
    ["agent", "model unavailable"],
    ["status", "Worker needs your attention"],
    ["status", "Stopped"],
    ["user", "retry"],
  ]);
  assert.equal(transcript[1].tone, "error");
});
