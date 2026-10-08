"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const load = (file) => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features", file), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports });
  return exports;
};
const chat = load("ao-chat.ts");
const md = load("chat-markdown.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const node = (id, role, state, extra = {}) => ({ id, role, state, x: 0, ...extra });
const run = (id, taskId, nodes, extra = {}) => ({ id, project_id: taskId, cancelled: false, nodes, ...extra });

test("the list shows Codex ages and keeps archived chats in their own section", () => {
  const now = Date.UTC(2026, 9, 8, 12);
  assert.equal(chat.chatRelativeTime(now - 30_000, now), "now");
  assert.equal(chat.chatRelativeTime(now - 5 * 60_000, now), "5m");
  assert.equal(chat.chatRelativeTime(now - 3 * 3_600_000, now), "3h");
  assert.equal(chat.chatRelativeTime(now - 2 * 86_400_000, now), "2d");
  assert.equal(chat.chatRelativeTime(now - 15 * 86_400_000, now), "2w");
  assert.equal(chat.chatRelativeTime(undefined, now), "");
  const runs = [run("r1", "a", [node("p", "planner", "finished")]), run("r2", "b", [node("p", "planner", "finished")])];
  const tasks = [{ id: "a", title: "Kept", state: "done", updated_at: 1_000 }, { id: "b", title: "Old", state: "archived", updated_at: 2_000 }];
  assert.deepEqual(plain(chat.chatList(runs, tasks)).map((entry) => [entry.title, entry.updatedAtMs]), [["Kept", 1_000_000]]);
  assert.deepEqual(plain(chat.chatArchived(runs, tasks)).map((entry) => entry.title), ["Old"]);
});

test("a turn collapses the cards' work and shows the reviewer's answer in full", () => {
  const runs = [run("r1", "t", [
    node("rev", "reviewer", "finished", { receipt: { answer: "APPROVED — all good", verdict: "APPROVED" } }),
    node("w1", "worker", "finished", { x: 1, receipt: { answer: "fixed it", started_at_ms: 2_000 } }),
    node("p", "planner", "finished", { receipt: { answer: "plan", started_at_ms: 1_000 } }),
    node("idle", "worker", "pending", { x: 2 }),
  ])];
  const [turn] = plain(chat.chatTurns(runs, "fix it", { describe: (entry) => `model · ${entry.role}` }));
  assert.equal(turn.user.text, "fix it");
  assert.deepEqual(turn.steps.map((step) => step.name), ["Orchestrator", "Worker"], "an untouched pending card is not shown");
  assert.equal(turn.final.text, "APPROVED — all good");
  assert.equal(turn.final.verdict, "APPROVED");
  assert.equal(turn.steps[1].detail, "model · worker");
  assert.equal(turn.startedAtMs, 1_000);
  assert.equal(turn.status, "queued", "the untouched card keeps the run from counting as settled");
});

test("a solo turn closes with the orchestrator's answer; a working card carries its live detail", () => {
  const solo = plain(chat.chatTurns([run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "391\n\n```solo\n{}\n```" } })], { solo: true })], "17*23?"));
  assert.equal(solo[0].final.text, "391");
  assert.deepEqual(solo[0].steps, []);
  const now = 10_000_000;
  const working = plain(chat.chatTurns([run("r2", "t", [node("w", "worker", "running", { receipt: { started_at_ms: now - 90_000 } })])], "go",
    { activity: { "r2:w": { activity: "running a command", last_event_at_ms: now - 5_000, turn_started: true } }, now }));
  assert.equal(working[0].steps[0].working.activity, "running a command");
  assert.match(working[0].steps[0].working.detail, /running 1m · running a command \(last heard 5s ago\)/);
  assert.equal(working[0].final, undefined);
  const pending = plain(chat.chatTurns([], "first message"));
  assert.equal(pending[0].user.text, "first message");
  assert.equal(pending[0].runId, "");
});

test("forking keeps the conversation up to the chosen message, in the follow-up format the engine reads", () => {
  const description = "first\n\nFollow-up (2026-10-08 01:00 UTC):\nsecond\n\nFollow-up (2026-10-08 02:00 UTC):\nthird";
  const forked = chat.chatDescriptionUpTo(description, 1);
  assert.equal(forked, "first\n\nFollow-up (2026-10-08 01:00 UTC):\nsecond");
  assert.deepEqual(plain(chat.chatMessagesFromDescription(forked)).map((message) => message.text), ["first", "second"]);
  const copied = chat.chatMarkdown("Title", plain(chat.chatTurns([run("r1", "t", [node("p", "planner", "finished", { receipt: { answer: "done" } })])], "do it")));
  assert.equal(copied, "# Title\n\n**You:**\n\ndo it\n\n**Orchestrator:**\n\ndone");
});

test("slash commands offer only what applies, and attachments become paths or inline text", () => {
  assert.deepEqual(plain(chat.chatSlashMatches("/", { chat: false, run: false })).map((command) => command.name), ["new", "model", "board"]);
  assert.deepEqual(plain(chat.chatSlashMatches("/st", { chat: true, run: true })).map((command) => command.name), ["stop", "structure"]);
  assert.deepEqual(plain(chat.chatSlashMatches("/stop now", { chat: true, run: true })), [], "a space ends the command menu");
  assert.equal(chat.chatSlashCommand(" /Stop "), "stop");
  assert.equal(chat.chatSlashCommand("/unknown"), null);
  assert.equal(chat.chatMessageWithAttachments("look", [
    { name: "a.png", path: "C:\\shots\\a.png", image: true },
    { name: "notes.txt", text: "x ``` y" },
  ]), "look\n\nAttached image: C:\\shots\\a.png\n\nAttached file `notes.txt`:\n```\nx ``\u200b` y\n```");
});

test("answers render as Markdown data, never HTML, and only web links are clickable", () => {
  const blocks = plain(md.parseMarkdown("# Title\n\nSome **bold** and `code` and [site](https://x.dev) [bad](javascript:alert(1))\n\n- one\n- two\n  more\n\n1. a\n2. b\n\n```js\nconst a = 1;\n```\n\n> quoted\n\n---\n<script>x</script>"));
  assert.deepEqual(blocks.map((block) => block.kind), ["heading", "paragraph", "list", "list", "code", "quote", "rule", "paragraph"]);
  const inline = blocks[1].inline;
  assert.deepEqual(inline.filter((part) => part.kind !== "text").map((part) => part.kind), ["strong", "code", "link"]);
  assert.equal(inline.find((part) => part.kind === "link").href, "https://x.dev");
  assert.ok(inline.some((part) => part.kind === "text" && part.text.includes("bad")), "a javascript: link stays text");
  assert.deepEqual(blocks[2].items.map((item) => item.map((part) => part.text).join("")), ["one", "two\nmore"]);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual([blocks[4].lang, blocks[4].text], ["js", "const a = 1;"]);
  assert.equal(blocks[7].inline[0].text, "<script>x</script>", "raw HTML is shown as text");
  assert.equal(md.safeHref("file:///C:/x"), null);
  const unclosed = plain(md.parseMarkdown("```\nstill code"));
  assert.deepEqual([unclosed[0].kind, unclosed[0].text], ["code", "still code"]);
});
