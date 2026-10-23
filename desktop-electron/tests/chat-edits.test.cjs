"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));
const { chatDescriptionWithout, createChatEditStore } = require("../electron/chat-edits.cjs");

// The renderer's own parser, so the rewritten description is checked the way the chat reads it.
const chat = (() => {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ao-chat.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText,
    { exports, require: () => ({}) });
  return exports;
})();
const said = (description) => JSON.parse(JSON.stringify(chat.chatMessagesFromDescription(description)));

const description = [
  "first ask\n\n↳ Steer (2026-10-10 09:05 UTC): smaller diff",
  "Follow-up (2026-10-10 10:00 UTC):\nsecond ask\nwith two lines\n\n↳ Steer (2026-10-10 10:05 UTC): use pnpm\n\n↳ Steer (2026-10-10 10:06 UTC): and node 22",
  "Follow-up (2026-10-10 11:00 UTC):\nthird ask",
].join("\n\n");

test("deleting the first message makes the next one first, with its steers kept", () => {
  const after = chatDescriptionWithout(description, 0);
  assert.equal(after, "second ask\nwith two lines\n\n↳ Steer (2026-10-10 10:05 UTC): use pnpm\n\n↳ Steer (2026-10-10 10:06 UTC): and node 22"
    + "\n\nFollow-up (2026-10-10 11:00 UTC):\nthird ask");
  const [, second, third] = said(description);
  const { stamp: _stamp, ...first } = second; // a first message has no follow-up stamp
  assert.deepEqual(said(after), [first, third]);
});

test("deleting a follow-up takes its steers along and leaves every other message exactly as it was", () => {
  const after = chatDescriptionWithout(description, 1);
  assert.equal(after, "first ask\n\n↳ Steer (2026-10-10 09:05 UTC): smaller diff\n\nFollow-up (2026-10-10 11:00 UTC):\nthird ask");
  assert.deepEqual(said(after), [said(description)[0], said(description)[2]]);
});

test("deleting the last message drops just its block", () => {
  const after = chatDescriptionWithout(description, 2);
  assert.ok(description.startsWith(after));
  assert.deepEqual(said(after), said(description).slice(0, 2));
});

test("the only message, or one that is not there, is refused", () => {
  assert.throws(() => chatDescriptionWithout("just one\n\n↳ Steer (2026-10-10 09:05 UTC): x", 0), /only message; archive or delete the chat instead/);
  assert.throws(() => chatDescriptionWithout(description, 3), /no longer in this chat/);
  assert.throws(() => chatDescriptionWithout(description, -1), /no longer in this chat/);
  assert.throws(() => chatDescriptionWithout(description, 1.5), /no longer in this chat/);
});

test("the store hides deleted messages' runs per project, flags a fresh session, and survives a restart", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "chat-edits-"));
  try {
    const file = path.join(folder, "integrations", "chat-edits.json");
    const store = createChatEditStore({ file });
    const runs = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];
    assert.equal(store.visible("ws-1", runs), runs, "nothing deleted: the same list");
    store.deleteMessage("ws-1", "task-1", ["r2"]);
    assert.deepEqual(store.visible("ws-1", runs).map(run => run.id), ["r1", "r3"]);
    assert.deepEqual(store.visible("ws-2", runs).map(run => run.id), ["r1", "r2", "r3"], "another project is untouched");
    assert.equal(store.fresh("ws-1", "task-1"), true);
    assert.equal(store.fresh("ws-1", "task-2"), false);
    const reopened = createChatEditStore({ file });
    assert.deepEqual(reopened.visible("ws-1", runs).map(run => run.id), ["r1", "r3"]);
    assert.equal(reopened.fresh("ws-1", "task-1"), true);
    reopened.clearFresh("ws-1", "task-1");
    assert.equal(createChatEditStore({ file }).fresh("ws-1", "task-1"), false);
    assert.deepEqual(createChatEditStore({ file }).visible("ws-1", runs).map(run => run.id), ["r1", "r3"], "the run stays hidden");
    // A delete whose task edit failed is put back as it was.
    const before = reopened.get("ws-1", "task-1");
    reopened.deleteMessage("ws-1", "task-1", ["r3"]);
    reopened.restore("ws-1", "task-1", before);
    assert.deepEqual(reopened.visible("ws-1", runs).map(run => run.id), ["r1", "r3"]);
    assert.equal(reopened.fresh("ws-1", "task-1"), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("a restart is marked on its run, so the chat shows it under the message it answers again", () => {
  const store = createChatEditStore();
  const runs = [{ id: "r1" }, { id: "r1b" }, { id: "r1c" }, { id: "r2" }];
  store.restarted("ws-1", "task-1", "r1", "r1b");
  store.restarted("ws-1", "task-1", "r1b", "r1c");
  assert.deepEqual(store.visible("ws-1", runs), [{ id: "r1" }, { id: "r1b", restarts_run_id: "r1" }, { id: "r1c", restarts_run_id: "r1b" }, { id: "r2" }]);
  assert.deepEqual(runs[1], { id: "r1b" }, "the runs read from AO are not changed");
  assert.deepEqual(store.runsOfMessage("ws-1", "task-1", "r1"), ["r1", "r1b", "r1c"], "a restart of a restart is the same message too");
  assert.deepEqual(store.runsOfMessage("ws-1", "task-1", "r2"), ["r2"]);
  assert.equal(store.fresh("ws-1", "task-1"), false, "a restart alone asks for nothing fresh");
  // The renderer reads the same chain, from the bridge's marks and its own reconfigure replacements.
  const shown = [...store.visible("ws-1", runs), { id: "r2r", replaces_run_id: "r2" }];
  assert.deepEqual([...chat.chatRunsOfMessage(shown, "r1")], ["r1", "r1b", "r1c"]);
  assert.deepEqual([...chat.chatRunsOfMessage(shown, "r2")], ["r2", "r2r"]);
  assert.deepEqual([...chat.chatRunsOfMessage(shown, "")], [], "a message that has not run has no runs");
});
