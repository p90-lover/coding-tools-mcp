const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const load = (file, deps = {}) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, require: (name) => deps[name] ?? {} });
  return exports;
};
const chat = load("ao-chat.ts");
const plan = load("chat-reply-plan.ts", { "./ao-chat": chat });
const head = load("ChatReplyHead.tsx", { "./ao-chat": chat });
const plain = (value) => JSON.parse(JSON.stringify(value));

const message = (id, text) => ({ id, kind: "message", status: "completed", text });
const command = (id, status = "completed") => ({ id, kind: "command", status, text: "npm test", label: "bash" });
const edit = (id) => ({ id, kind: "edit", status: "completed", text: "Edited a.js", files: [{ path: "a.js", additions: 1, deletions: 0 }] });

test("a reply's steps are the agent's messages, each with the tool calls after it; the closing message is the answer", () => {
  const items = [command("c0"), message("m1", "## Reading the **failing** test\nmore"), command("c1"), command("c2", "failed"),
    message("m2", "Fixing the parser"), edit("e1"), command("c3"), message("m3", "All green now.")];
  const done = plain(plan.replyPlan(items, false));
  assert.equal(done.source, "work");
  assert.deepEqual(done.steps.map((step) => [step.title, step.state, step.finish]), [
    ["1 command", "done", undefined],
    ["Reading the failing test", "done", "2 commands · 1 failed"],
    ["Fixing the parser", "done", "1 edit, 1 command"],
  ]);
  assert.equal(done.done, 3);
  // While it runs, the newest step is the one running, and a message with nothing after it yet is a step.
  const live = plain(plan.replyPlan(items, true));
  assert.deepEqual(live.steps.map((step) => step.state), ["done", "done", "done", "running"]);
  // A turn that ended on an error fails its newest step, with the error as how it ended.
  const failed = plain(plan.replyPlan(items.slice(0, 7), false, "API error 529"));
  assert.deepEqual(failed.steps.at(-1), { key: "m2", title: "Fixing the parser", state: "failed", finish: "API error 529",
    actions: [{ activity: "edit", count: 1, words: "1 edit" }, { activity: "commands", count: 1, words: "1 command" }] });
});

test("the agent's own todo list is the plan when it kept one (TodoWrite or update_plan)", () => {
  const todo = { id: "t1", kind: "tool", status: "completed", label: "TodoWrite", text: "TodoWrite",
    input: JSON.stringify({ todos: [{ content: "Find the bug", status: "completed" }, { content: "Fix it", status: "in_progress" }, { content: "Ship", status: "pending" }] }) };
  const update = { id: "t2", kind: "tool", status: "completed", label: "update_plan", text: "update_plan",
    input: JSON.stringify({ plan: [{ step: "Find the bug", status: "completed" }, { step: "Fix it", status: "completed" }] }) };
  assert.deepEqual(plain(plan.replyPlan([message("m", "go"), todo], true)).steps.map((step) => [step.title, step.state]),
    [["Find the bug", "done"], ["Fix it", "running"], ["Ship", "pending"]]);
  // The newest list wins; a list that cannot be read is skipped.
  const newest = plain(plan.replyPlan([todo, update, { ...update, id: "t3", input: "{not json" }], false));
  assert.deepEqual([newest.source, newest.done, newest.steps.length], ["agent", 2, 2]);
});

test("a goal's rounds are numbered from the person's message, and all but the newest two fold", () => {
  const feedback = (reason) => ({ text: `Stop hook feedback:\n[ship it]: ${reason}` });
  const turns = [{ key: "a", user: { text: "hello" } }, { key: "g", user: { text: "ship it" } },
    ...[1, 2, 3, 4].map((n) => ({ key: `r${n}`, user: feedback(`reason ${n}`) })), { key: "b", user: { text: "thanks" } }];
  assert.equal(plan.goalRound(turns, 1), null);
  assert.deepEqual(plain(plan.goalRound(turns, 2)), { round: 2, reason: "reason 1" });
  assert.deepEqual(plain(plan.goalRound(turns, 5)), { round: 5, reason: "reason 4" });
  assert.deepEqual(plain([...plan.foldedRounds(turns)]), [["r1", [2, 3]]]);
  assert.equal(plan.foldedRounds(turns.slice(0, 4)).size, 0, "two rounds fold nothing");
});

test("a retried card's attempt counts its earlier attempts, not a reviewer's cycles", () => {
  assert.equal(plan.stepAttempt(undefined), 1);
  assert.equal(plan.stepAttempt({ earlier: [{ label: "Attempt 1", text: "" }, { label: "Attempt 2", text: "" }] }), 3);
  assert.equal(plan.stepAttempt({ earlier: [{ label: "Cycle 1", text: "" }] }), 1);
});

test("a chat style read back from storage falls back to the transcript", () => {
  assert.equal(plan.chatStyle("timeline"), "timeline");
  assert.equal(plan.chatStyle("nope"), "transcript");
  assert.equal(plan.chatStyle(null), "transcript");
  assert.deepEqual(plain(plan.CHAT_STYLES.map((style) => style.id)), ["transcript", "plan", "timeline", "focus", "cascade"]);
});

test("the head lists the biggest changes first, lockfiles and build output last", () => {
  const files = [{ path: "src/a.ts", additions: 2, deletions: 1 }, { path: "package-lock.json", additions: 900, deletions: 40 },
    { path: "src/b.ts", additions: 30, deletions: 3 }, { path: "dist\\app.js", additions: 500, deletions: 0 }, { path: "src/c.ts", additions: 1, deletions: 2 }];
  assert.deepEqual(plain(head.orderChanges(files).map((file) => file.path)), ["src/b.ts", "src/a.ts", "src/c.ts", "package-lock.json", "dist\\app.js"]);
  // Ties keep the order first touched.
  assert.deepEqual(plain(head.orderChanges([{ path: "x", additions: 1, deletions: 0 }, { path: "y", additions: 0, deletions: 1 }]).map((file) => file.path)), ["x", "y"]);
});
