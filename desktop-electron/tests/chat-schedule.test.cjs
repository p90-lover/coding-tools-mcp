"use strict";

// /schedule's renderer side (ao-chat.ts): the time it reads from what the person typed, the words the
// bar and the chat details show, and the two commands in the slash menu.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const chat = {};
const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, { exports: chat });

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
// 14:00 local time on 2026-11-08: clock times are read in the person's own time zone.
const at = new Date(2026, 10, 8, 14, 0, 0, 0).getTime();
const local = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0, 0).getTime();
const parse = (text) => JSON.parse(JSON.stringify(chat.chatScheduleParse(text, at)));

test("a duration is read in any of the usual ways: 5h is five hours", () => {
  for (const [text, ms] of [
    ["5h", 5 * HOUR], ["5 hours", 5 * HOUR], ["5hrs", 5 * HOUR], ["in 5h", 5 * HOUR],
    ["90m", 90 * MINUTE], ["90 minutes", 90 * MINUTE], ["10mins", 10 * MINUTE], ["1h30m", 90 * MINUTE], ["1h 30m", 90 * MINUTE],
    ["1.5h", 90 * MINUTE], ["2 days and 3 hours", 2 * DAY + 3 * HOUR], ["1d, 2h", DAY + 2 * HOUR], ["1w", 7 * DAY], ["120s", 2 * MINUTE],
  ]) {
    const parsed = parse(text);
    assert.equal(parsed.dueAt, at + ms, text);
    assert.equal(parsed.message, "", `${text}: no words, so the chat is told to continue`);
  }
  assert.equal(parse("in 5h").spec, "in 5h");
});

test("what follows the time is the message sent", () => {
  assert.deepEqual(parse("5h run the tests again"), { dueAt: at + 5 * HOUR, message: "run the tests again", spec: "5h" });
  assert.equal(parse("1h30m: check the deploy").message, "check the deploy");
  assert.equal(parse("2h - continue the refactor").message, "continue the refactor");
  assert.equal(parse("9pm then summarise the day").message, "summarise the day");
  assert.equal(parse("tomorrow 9am check the overnight build").message, "check the overnight build");
});

test("a clock time is its next time, today or tomorrow", () => {
  assert.equal(parse("21:00").dueAt, local(8, 21), "later today");
  assert.equal(parse("9pm").dueAt, local(8, 21));
  assert.equal(parse("9:30 pm").dueAt, local(8, 21, 30));
  assert.equal(parse("at 9:30PM").dueAt, local(8, 21, 30));
  assert.equal(parse("9:30").dueAt, local(9, 9, 30), "already passed today: tomorrow");
  assert.equal(parse("9am").dueAt, local(9, 9));
  assert.equal(parse("tomorrow 9am").dueAt, local(9, 9));
  assert.equal(parse("tomorrow at 15:45").dueAt, local(9, 15, 45), "tomorrow even when it is still ahead today");
  assert.equal(parse("tonight 11:30").dueAt, local(8, 23, 30), "tonight reads a morning hour as the evening");
  assert.equal(parse("12am").dueAt, local(9, 0), "midnight");
  assert.equal(parse("12pm").dueAt, local(9, 12), "noon, passed today");
  assert.equal(parse("14:00").dueAt, local(9, 14), "the very minute now is tomorrow's");
  assert.equal(parse("9:30").spec, "9:30");
});

test("a time that can't be read, or that is too soon or too far, says how to write it", () => {
  assert.match(parse("").error, /Say when: \/schedule 5h/);
  assert.match(parse("soon").error, /Say when/);
  assert.match(parse("5").error, /5h for hours, 5m for minutes, or 5:00 or 5pm/);
  assert.match(parse("5 more minutes").error, /5h for hours/, "\"m\" of \"more\" is not a unit");
  assert.match(parse("30s").error, /at least 1 minute/);
  assert.match(parse("31d").error, /at most 30 days/);
  assert.match(parse("25:00").error, /not a time of day/);
  assert.match(parse("13pm").error, /not a time of day/);
  assert.match(parse("9:75").error, /not a time of day/);
  assert.match(parse("today 9am").error, /already passed/);
  assert.match(chat.chatScheduleParse("14:00", new Date(2026, 10, 8, 13, 59, 30).getTime()).error, /at least 1 minute/, "less than a minute away");
});

test("the bar and the chat details count down and say when", () => {
  assert.equal(chat.scheduleCountdown(42_000), "42s");
  assert.equal(chat.scheduleCountdown(185_000), "4m");
  assert.equal(chat.scheduleCountdown(5 * HOUR - MINUTE), "4h 59m");
  assert.equal(chat.scheduleCountdown(DAY + 3 * HOUR), "1d 3h");
  assert.equal(chat.scheduleLabel({ dueAt: at + 5 * HOUR }, at), "Continues in 5h 0m");
  assert.equal(chat.scheduleLabel({ dueAt: at + 5 * HOUR, due: true }, at), "Continues after this turn", "due while the chat works");
  assert.equal(chat.scheduleLabel({ dueAt: at - 1 }, at), "Continues after this turn");
  assert.equal(chat.scheduleWhen(local(8, 19, 5), at), "today 19:05");
  assert.equal(chat.scheduleWhen(local(9, 9), at), "tomorrow 09:00");
  assert.match(chat.scheduleWhen(local(12, 9), at), /^Thu 12 Nov 09:00$/);
});

test("/schedule and /clearschedule are in the slash menu and parse as commands", () => {
  // Arrays made in the sandbox have its prototypes: compare plain copies.
  const names = (draft, inChat = true) => JSON.parse(JSON.stringify(chat.chatSlashMatches(draft, { chat: inChat, run: false }).map((command) => command.name)));
  assert.ok(names("/sch").includes("schedule"));
  assert.ok(names("/clear").includes("clearschedule"));
  assert.deepEqual(names("/sch").concat(names("/clears")).filter((name) => /schedule/.test(name)), ["schedule", "clearschedule"]);
  assert.deepEqual(names("/sch", false), [], "only in a chat");
  assert.deepEqual(JSON.parse(JSON.stringify(chat.chatSlashParse("/schedule 5h run the tests"))), { name: "schedule", arg: "5h run the tests" });
  assert.deepEqual(JSON.parse(JSON.stringify(chat.chatSlashParse("/clearschedule"))), { name: "clearschedule", arg: "" });
  assert.equal(chat.chatSlashParse("/clearschedule now"), null, "it takes no argument");
  assert.equal(chat.chatSlashTyping("/schedule 5").name, "schedule", "its usage shows while the time is typed");
});
