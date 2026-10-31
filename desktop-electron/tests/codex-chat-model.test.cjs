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
  assert.match(working[0].steps[0].working.detail, /running 1m · running a command · last heard 5s ago/);
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
  assert.deepEqual(plain(chat.chatSlashMatches("/", { chat: false, run: false })).map((command) => command.name),
    ["goal", "plan", "autocompact", "review", "init", "status", "diff", "mcp", "model", "effort", "new", "clear", "resume", "board"], "Codex's commands first; chat-only ones need a chat");
  assert.deepEqual(plain(chat.chatSlashMatches("/st", { chat: true, run: true })).map((command) => command.name), ["status", "stop", "structure"]);
  assert.deepEqual(plain(chat.chatSlashMatches("/st", { chat: true, run: true, open: false })).map((command) => command.name), ["status", "structure"], "/stop only while a mission is open");
  assert.deepEqual(plain(chat.chatSlashMatches("/co", { chat: true, run: true })).map((command) => command.name), ["compact", "context", "copy"]);
  assert.deepEqual(plain(chat.chatSlashMatches("/stop now", { chat: true, run: true })), [], "a space ends the command menu");
  assert.equal(chat.chatSlashCommand(" /Stop "), "stop");
  assert.equal(chat.chatSlashCommand("/unknown"), null);
  // Commands with an argument, as Codex takes them: /goal <objective>|pause|resume|edit|clear, /review [focus].
  assert.deepEqual(plain(chat.chatSlashParse("/goal make every test pass")), { name: "goal", arg: "make every test pass" });
  assert.deepEqual(plain(chat.chatSlashParse("/Goal pause")), { name: "goal", arg: "pause" });
  assert.deepEqual(plain(chat.chatSlashParse("/goal\nship the release\nwith notes")), { name: "goal", arg: "ship the release\nwith notes" });
  assert.deepEqual(plain(chat.chatSlashParse("/review the auth changes")), { name: "review", arg: "the auth changes" });
  assert.deepEqual(plain(chat.chatSlashParse("/status")), { name: "status", arg: "" });
  assert.equal(chat.chatSlashParse("/status now"), null, "a command without arguments followed by text is just a message");
  assert.equal(chat.chatSlashParse("/etc/hosts is broken"), null, "a path is a message, not a command");
  assert.equal(chat.chatSlashParse("please /goal x"), null);
  assert.deepEqual(plain(chat.chatSlashParse("/rewind 2")), { name: "rewind", arg: "2" });
  // /loop reads its interval as Claude Code's does: a leading "5m", a trailing "every …", or none (self-paced).
  assert.deepEqual(plain(chat.chatSlashParse("/loop 5m /review")), { name: "loop", arg: "5m /review" });
  assert.deepEqual(plain(chat.chatLoopParse("5m check the deploy")), { prompt: "check the deploy", minutes: 5 });
  assert.deepEqual(plain(chat.chatLoopParse("2h /review the auth changes")), { prompt: "/review the auth changes", minutes: 120 });
  assert.deepEqual(plain(chat.chatLoopParse("check the deploy every 20 minutes")), { prompt: "check the deploy", minutes: 20 });
  assert.deepEqual(plain(chat.chatLoopParse("30s ping")), { prompt: "ping", minutes: 1 }, "seconds round up to a minute");
  assert.deepEqual(plain(chat.chatLoopParse("1d summarize the day")), { prompt: "summarize the day", minutes: 1440 });
  assert.deepEqual(plain(chat.chatLoopParse("watch CI and fix what fails")), { prompt: "watch CI and fix what fails", minutes: null });
  assert.deepEqual(plain(chat.chatLoopParse("5 tests fail, fix them")), { prompt: "5 tests fail, fix them", minutes: null }, "a number alone is not an interval");
  assert.match(chat.chatLoopParse("5m").error, /Say what to run/);
  assert.match(chat.chatLoopParse("2d x").error, /1 minute to 1 day/);
  assert.match(chat.chatLoopParse("0m x").error, /1 minute to 1 day/);
  assert.equal(chat.loopInterval(90), "1h 30m");
  assert.equal(chat.loopLabel({ minutes: 5, round: 2, nextAt: 185_000, due: false }, 0), "Every 5m · next in 4m");
  assert.equal(chat.loopLabel({ minutes: 5, round: 2, nextAt: 0, due: true }, 0), "Every 5m · next after this turn");
  assert.equal(chat.loopLabel({ minutes: null, round: 3, nextAt: null }, 0), "Self-paced · round 3");
  // A chat's queue: plain messages typed in a row are sent together; a command or goal keeps its own
  // turn, and nothing already queued is ever replaced.
  let queue = chat.chatQueueAdd([], { what: "Message", message: "first" });
  queue = chat.chatQueueAdd(queue, { what: "Message", message: "second" });
  queue = chat.chatQueueAdd(queue, { what: "Goal", message: "ship it", goal: "ship it" });
  queue = chat.chatQueueAdd(queue, { what: "Message", message: "third" });
  assert.deepEqual(plain(queue), [{ what: "Message", message: "first\n\nsecond" }, { what: "Goal", message: "ship it", goal: "ship it" }, { what: "Message", message: "third" }]);
  assert.equal(chat.chatSlashTyping("/goal fix")?.name, "goal");
  assert.equal(chat.chatSlashTyping("/status x"), null);
  assert.equal(chat.goalElapsed(0, 50_000), "50s");
  assert.equal(chat.goalElapsed(0, 4 * 60_000), "4m 0s");
  assert.equal(chat.goalElapsed(0, ((7 * 24 + 4) * 60 + 4) * 60_000 + 50_000), "7d 4h 4m 50s", "Codex's goal timer");
  assert.equal(chat.chatMessageWithAttachments("look", [
    { name: "a.png", path: "C:\\shots\\a.png", image: true },
    { name: "notes.txt", text: "x ``` y" },
  ]), "look\n\nAttached image: C:\\shots\\a.png\n\nAttached file `notes.txt`:\n```\nx ``\u200b` y\n```");
});

test("Claude Code's /autocompact, /compact [focus], /context, /effort and /clear are chat commands", () => {
  assert.deepEqual(plain(chat.chatSlashParse("/compact focus on the API changes")), { name: "compact", arg: "focus on the API changes" });
  assert.deepEqual(plain(chat.chatSlashParse("/autocompact 80")), { name: "autocompact", arg: "80" });
  for (const name of ["context", "effort", "clear"]) assert.deepEqual(plain(chat.chatSlashParse(`/${name}`)), { name, arg: "" });
  assert.equal(chat.chatSlashParse("/context please"), null, "/context takes no argument");
  assert.equal(chat.autoCompactArg(""), null, "no argument shows the setting");
  assert.deepEqual(plain(chat.autoCompactArg("on")), { enabled: true });
  assert.deepEqual(plain(chat.autoCompactArg("OFF")), { enabled: false });
  assert.deepEqual(plain(chat.autoCompactArg("80%")), { enabled: true, percent: 80 }, "a share also turns it on");
  assert.deepEqual(plain(chat.autoCompactArg("100")), { enabled: true, percent: 100 });
  for (const wrong of ["10", "101", "eighty", "80 percent"]) assert.match(chat.autoCompactArg(wrong).error, /20% to 100%/, wrong);
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
  const flattened = plain(md.parseMarkdown("assignments\n\n`[{\"worker\":\"w1\",\"task\":\"Read-only review of the project root and every top-level file\"}]`"));
  assert.deepEqual(flattened.map((block) => block.kind), ["paragraph", "code"], "a flattened JSON block reads as code");
  assert.deepEqual(plain(md.parseMarkdown("Use `npm test` here")).map((block) => block.kind), ["paragraph"], "short inline code stays inline");
  const unclosed = plain(md.parseMarkdown("```\nstill code"));
  assert.deepEqual([unclosed[0].kind, unclosed[0].text], ["code", "still code"]);
});
