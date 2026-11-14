const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChatDraftStore, cleanDraft } = require("../electron/chat-drafts.cjs");

// Temporary files go under the repository's aiTemp, never the system drive's temp folder.
const scratch = (t) => {
  const dir = fs.mkdtempSync(path.join(path.resolve(__dirname, "../../aiTemp"), "chat-drafts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "chat-drafts.json");
};

test("a composer's unsent text, files and annotations are saved and read back; an empty draft removes the copy", () => {
  // The user, 2026-11-14: "any of typed message/image/files/etc that waiting to send out should be
  // saved ... just like claude code, codex etc to prevent any crashed etc that will loss the prompt".
  let time = 1000;
  const store = createChatDraftStore({ now: () => time });
  const draft = {
    text: "Refactor the queue drain\nand keep the order",
    attachments: [
      { name: "shot.png", path: "G:\\AppData\\Coding Tools\\attachments\\shot.png", image: true, preview: "blob:app/123", markup: "1. the red box" },
      { name: "notes.md", text: "# notes" },
      { name: "nothing" },
    ],
    annotations: [{ id: 7, quote: "drain", note: "this one", anchor: { answer: 2, start: 10, end: 15 } }],
  };
  assert.equal(store.set("ws1", "task-1", draft), true);
  const read = store.get("ws1", "task-1");
  assert.equal(read.text, draft.text);
  assert.deepEqual(read.attachments, [
    { name: "shot.png", path: "G:\\AppData\\Coding Tools\\attachments\\shot.png", image: true, markup: "1. the red box" },
    { name: "notes.md", text: "# notes" },
  ], "a file keeps its path or its text; the thumbnail URL and a file with neither are not kept");
  assert.deepEqual(read.annotations, [{ quote: "drain", note: "this one", anchor: { answer: 2, start: 10, end: 15 } }], "an annotation without its window-local id");
  assert.equal(read.at, 1000);
  assert.equal(store.get("ws2", "task-1"), null, "each project keeps its own");
  assert.equal(store.set("ws1", "task-1", { text: "   ", attachments: [], annotations: [] }), false);
  assert.equal(store.get("ws1", "task-1"), null, "sent or emptied: the copy goes");
  assert.equal(store.set("ws1", "task-1", null), false);
  assert.throws(() => store.set("", "task-1", draft), /project and chat/);
});

test("drafts survive a restart and a torn file, and the oldest make room past the limit", async (t) => {
  const file = scratch(t);
  let time = 1;
  const first = createChatDraftStore({ file, now: () => time });
  first.set("ws1", JSON.stringify(["new", "ws1", "main"]), { text: "a new chat's first message", attachments: [], annotations: [] });
  time += 1;
  first.set("ws1", "task-9", { text: "half-written follow-up", attachments: [{ name: "a.txt", path: "G:\\a.txt" }], annotations: [] });
  await first.saved();

  const second = createChatDraftStore({ file, now: () => time });
  assert.equal(second.get("ws1", JSON.stringify(["new", "ws1", "main"])).text, "a new chat's first message", "an app restart keeps it");
  assert.equal(second.get("ws1", "task-9").attachments[0].path, "G:\\a.txt");

  // A power cut tears the file: the copy beside it is read instead.
  fs.writeFileSync(file, "\u0000\u0000\u0000");
  const warnings = [];
  const third = createChatDraftStore({ file, now: () => time, logger: { warn: (event) => warnings.push(event) } });
  assert.equal(third.get("ws1", "task-9").text, "half-written follow-up");
  assert.deepEqual(warnings, ["chat_drafts.restored_from_copy"]);

  const many = createChatDraftStore({ now: () => time });
  for (let index = 0; index < 205; index += 1) { time += 1; many.set("ws", `task-${index}`, { text: `draft ${index}`, attachments: [], annotations: [] }); }
  assert.equal(many.get("ws", "task-0"), null, "the oldest draft made room");
  assert.equal(many.get("ws", "task-204").text, "draft 204");
  assert.equal(many.get("ws", "task-5").text, "draft 5", "200 are kept");
});

test("a draft's sizes are bounded", () => {
  const big = cleanDraft({ text: "x".repeat(200_000), attachments: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, text: "y".repeat(300_000) })), annotations: [] });
  assert.equal(big.text.length, 64 * 1024);
  assert.equal(big.attachments.length, 30);
  assert.equal(big.attachments[0].text.length, 256 * 1024);
  assert.equal(cleanDraft({ text: "", attachments: [{ name: "x" }], annotations: [] }), null, "nothing worth keeping");
});
