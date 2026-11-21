"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { createChatInputStore } = require("../electron/chat-input-store.cjs");

function fixture(t, options = {}) {
  const parent = path.resolve(__dirname, "../../aiTemp/chat-input-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  const stores = [];
  const config = { file: path.join(root, "chat-inputs.sqlite"), attachmentsRoot: path.join(root, "attachments"), ...options };
  const open = extra => { const store = createChatInputStore({ ...config, ...extra }); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) await store.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, config, open };
}
const scope = { workspaceId: "project", key: "composer" };
const payload = text => ({ text, attachments: [], annotations: [] });
const save = (store, expectedRevision, text, mutationId = `save-${expectedRevision}`) => store.call("draftSave", { ...scope, expectedRevision, mutationId, draft: payload(text) });
const accept = (store, inputId, text, extra = {}) => store.call("accept", { ...scope, inputId, mode: "send", payload: payload(text), destination: { engine: "native", taskId: "chat" }, ...extra });

test("a committed revision and owned attachment survive abrupt worker exit and deletion of the original", async t => {
  let worker;
  const f = fixture(t), store = f.open({ createWorker(file, options) { worker = new Worker(file, options); return worker; } });
  const original = path.join(f.root, "original.txt");
  fs.writeFileSync(original, "preserve these exact bytes");
  const draft = { text: "inspect this", attachments: [{ name: "original.txt", path: original, markup: "important" }], annotations: [{ id: 99, quote: "exact", note: "keep", anchor: { answer: 1, start: 0, end: 5 } }] };
  const saved = await store.call("draftSave", { ...scope, expectedRevision: 0, mutationId: "first", draft });
  assert.equal(saved.revision, 1);
  assert.notEqual(saved.draft.attachments[0].path, original);
  assert.equal(path.basename(saved.draft.attachments[0].path), "original.txt");
  assert.match(saved.draft.attachments[0].blobId, /^[a-f0-9]{64}$/);
  assert.equal((await store.call("draftSave", { ...scope, expectedRevision: 0, mutationId: "first", draft })).duplicate, true);
  await assert.rejects(store.call("draftSave", { ...scope, expectedRevision: 0, mutationId: "first", draft: payload("different") }), { code: "INPUT_ID_CONFLICT" });
  await worker.terminate();
  fs.unlinkSync(original);
  const restored = await f.open().call("draftGet", scope);
  assert.equal(restored.revision, 1);
  assert.equal(fs.readFileSync(restored.draft.attachments[0].path, "utf8"), "preserve these exact bytes");
  assert.equal(restored.draft.attachments[0].markup, "important");
  assert.deepEqual(restored.draft.annotations, [{ quote: "exact", note: "keep", anchor: { answer: 1, start: 0, end: 5 } }]);
});

test("accepted attachment messages refer to owned bytes even before the draft was saved", async t => {
  const f = fixture(t), store = f.open();
  const original = path.join(f.root, "picture.png");
  fs.writeFileSync(original, "synthetic image bytes");
  const args = { ...scope, inputId: "attachment-input", mode: "send", payload: {
    text: "look", attachments: [{ name: "picture.png", path: original, image: true }], annotations: [],
  }, destination: { message: `look\nAttached image: ${original}\nAttached image: ${original}.other`, taskId: "chat" } };
  const accepted = await store.call("accept", args);
  const file = accepted.payload.attachments[0];
  assert.equal(accepted.destination.message, `look\nAttached image: ${file.path}\nAttached image: ${original}.other`);
  fs.unlinkSync(original);
  assert.equal(fs.readFileSync(file.path, "utf8"), "synthetic image bytes");
  const repeated = await store.call("accept", args);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.destination.message, accepted.destination.message);
  assert.equal(repeated.draft.revision, 0);
});

test("stale revisions preserve newer typing and keep conflict content for recovery", async t => {
  const store = fixture(t).open();
  await save(store, 0, "old");
  await save(store, 1, "newer");
  const conflict = await save(store, 1, "another window", "other-window");
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.revision, 2);
  assert.equal(conflict.draft.text, "newer");
  assert.equal((await store.call("draftConflicts", scope))[0].draft.text, "another window");
  const clearing = await store.call("draftSave", { ...scope, expectedRevision: 1, mutationId: "stale-clear", draft: null });
  assert.equal(clearing.conflict, true);
  assert.equal((await store.call("draftGet", scope)).draft.text, "newer");
});

test("input acceptance is idempotent and clears only its submitted draft revision", async t => {
  const store = fixture(t).open();
  await save(store, 0, "first");
  await save(store, 1, "typing while sending");
  const first = await accept(store, "input-1", "first", { draftRevision: 1 });
  assert.equal(first.state, "queued");
  assert.equal(first.draft.draft.text, "typing while sending");
  const duplicate = await accept(store, "input-1", "first", { draftRevision: 1 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.draft.revision, 2);
  assert.equal(duplicate.draft.draft.text, "typing while sending");
  await assert.rejects(accept(store, "input-1", "changed"), { code: "INPUT_ID_CONFLICT" });
  await assert.rejects(store.call("get", { workspaceId: "other", inputId: "input-1" }), { code: "INPUT_NOT_FOUND" });
  const next = await accept(store, "input-2", "typing while sending", { draftRevision: 2 });
  assert.equal(next.draft.draft, null);
  assert.equal(next.draft.revision, 3);
  const page = await store.call("list", { ...scope, limit: 1 });
  assert.equal(page.items.length, 1); assert.equal(page.hasMore, true);
  assert.equal((await store.call("list", { ...scope, after: page.cursor })).items[0].inputId, "input-2");
});

test("restart preserves queued input but never redispatches uncertain delivery", async t => {
  const f = fixture(t), first = f.open();
  await accept(first, "sent", "same text");
  await accept(first, "waiting", "same text");
  assert.equal((await first.call("dispatch", { workspaceId: "project", inputId: "sent" })).claimed, true);
  assert.equal((await first.call("dispatch", { workspaceId: "project", inputId: "sent" })).claimed, false);
  await first.close();
  const second = f.open();
  assert.equal((await second.call("get", { workspaceId: "project", inputId: "sent" })).state, "unknown");
  assert.equal((await second.call("dispatch", { workspaceId: "project", inputId: "sent" })).claimed, false);
  assert.equal((await second.call("get", { workspaceId: "project", inputId: "waiting" })).state, "queued");
  const receipt = { engine: "native", sessionId: "session", turnId: "turn", inputId: "sent" };
  assert.equal((await second.call("settle", { workspaceId: "project", inputId: "sent", expectedState: "unknown", state: "accepted", receipt })).state, "accepted");
});

test("editing queued input atomically saves its draft before cancelling the queue record", async t => {
  const store = fixture(t).open();
  await accept(store, "queued-edit", "queued message");
  await save(store, 0, "existing draft");
  const args = { ...scope, inputId: "queued-edit", expectedRevision: 1, mutationId: "edit-mutation", draft: payload("queued message\n\nexisting draft") };
  const result = await store.call("restoreDraft", args);
  assert.equal(result.restored, true);
  assert.equal(result.draft.revision, 2);
  assert.equal(result.draft.draft.text, "queued message\n\nexisting draft");
  assert.equal((await store.call("get", { workspaceId: "project", inputId: "queued-edit" })).state, "cancelled");
  assert.equal((await store.call("restoreDraft", args)).duplicate, true);
  await accept(store, "stale-edit", "second");
  await assert.rejects(store.call("restoreDraft", { ...args, inputId: "stale-edit", mutationId: "stale" }), { code: "INPUT_STATE_CONFLICT" });
  assert.equal((await store.call("get", { workspaceId: "project", inputId: "stale-edit" })).state, "queued");
});

test("capacity and validation failures preserve the last committed draft without eviction", async t => {
  const store = fixture(t, { maxStoredBytes: 1024 }).open();
  await save(store, 0, "last saved");
  await assert.rejects(save(store, 1, "x".repeat(2000)), { code: "INPUT_STORAGE_FULL" });
  assert.equal((await store.call("draftGet", scope)).draft.text, "last saved");
  await assert.rejects(save(store, 1, "x".repeat(1024 * 1024 + 1)), { code: "INPUT_INVALID" });
  assert.equal((await store.call("draftGet", scope)).revision, 1);
  await assert.rejects(store.call("draftSave", { ...scope, expectedRevision: 1, mutationId: "bad-file", draft: { ...payload("keep"), attachments: [{ name: "missing.txt", path: path.resolve(__dirname, "not-a-fixture") }] } }));
  assert.equal((await store.call("draftGet", scope)).draft.text, "last saved");
});

test("legacy imports are idempotent and do not overwrite a newer saved draft", async t => {
  const store = fixture(t).open();
  const args = { importId: "legacy-drafts-1", drafts: [{ ...scope, draft: payload("legacy text") }] };
  assert.equal((await store.call("importDrafts", args)).imported, 1);
  assert.equal((await store.call("importDrafts", args)).duplicate, true);
  await save(store, 1, "edited after import");
  assert.equal((await store.call("importDrafts", { ...args, importId: "legacy-copy-2" })).imported, 0);
  assert.equal((await store.call("draftGet", scope)).draft.text, "edited after import");
});

test("a lost acceptance response is recovered by the same input ID without duplication", async t => {
  const f = fixture(t);
  const broken = f.open({ createWorker(file, options) {
    const worker = new Worker(file, options), emit = worker.emit;
    worker.emit = function(event, message, ...rest) {
      if (event === "message" && message?.result?.inputId === "lost-reply") { void worker.terminate(); return true; }
      return emit.call(this, event, message, ...rest);
    };
    return worker;
  } });
  await assert.rejects(accept(broken, "lost-reply", "persist before reply"), { code: "INPUT_STORE_CLOSED" });
  await broken.close();
  const recovered = f.open();
  assert.equal((await accept(recovered, "lost-reply", "persist before reply")).duplicate, true);
  assert.equal((await recovered.call("list", scope)).items.length, 1);
});

test("version 1 draft and outbox survive native target migration and abrupt worker exit", async t => {
  const f = fixture(t), first = f.open();
  await save(first, 0, "kept draft");
  await accept(first, "kept-input", "queued");
  await first.close();
  const { DatabaseSync } = require("node:sqlite");
  const old = new DatabaseSync(f.config.file);
  old.exec("DROP TABLE native_send_targets; PRAGMA user_version=1");
  old.close();
  let worker;
  const next = f.open({ createWorker(file, options) { worker = new Worker(file, options); return worker; } });
  const key = { workspaceId: "project", runId: "run", nodeId: "card", requestId: "native-send" };
  const target = { sessionId: "native:session" };
  await next.call("bindNativeSendTarget", { ...key, ...target });
  await worker.terminate();
  const reopened = f.open();
  assert.deepEqual({ ...await reopened.call("readNativeSendTarget", key) }, target);
  assert.equal((await reopened.call("draftGet", scope)).draft.text, "kept draft");
  assert.equal((await reopened.call("get", { workspaceId: "project", inputId: "kept-input" })).state, "queued");
});

test("native target bindings are exact, immutable and charged to the journal budget", async t => {
  const store = fixture(t, { maxStoredBytes: 1024 }).open();
  await save(store, 0, "kept draft");
  const key = { workspaceId: "project", runId: "r".repeat(128), nodeId: "n".repeat(128), requestId: "a".repeat(128) };
  const sessionId = `native:${"s".repeat(120)}`;
  const bind = args => store.call("bindNativeSendTarget", args);
  const read = args => store.call("readNativeSendTarget", args);
  await bind({ ...key, sessionId });
  await bind({ ...key, sessionId });
  await assert.rejects(bind({ ...key, sessionId: "native:different" }), { code: "INPUT_STATE_CONFLICT" });
  await assert.rejects(bind({ ...key, requestId: "b".repeat(128), sessionId }), { code: "INPUT_STORAGE_FULL" });
  for (const changed of [{ workspaceId: "other" }, { runId: "other" }, { nodeId: "other" }, { requestId: "other" }]) {
    assert.equal(await read({ ...key, ...changed }), null);
  }
  assert.equal((await read(key)).sessionId, sessionId);
  assert.equal((await store.call("draftGet", scope)).draft.text, "kept draft");
});

test("unknown schema is refused without changing the input database", async t => {
  const f = fixture(t);
  const { DatabaseSync } = require("node:sqlite");
  const newer = new DatabaseSync(f.config.file);
  newer.exec("CREATE TABLE future(data TEXT); INSERT INTO future VALUES('preserve'); PRAGMA user_version=99;"); newer.close();
  const hash = () => createHash("sha256").update(fs.readFileSync(f.config.file)).digest("hex");
  const before = hash();
  await assert.rejects(f.open().call("draftGet", scope), { code: "INPUT_SCHEMA_UNSUPPORTED" });
  assert.equal(hash(), before);
});

test("a second input-store owner cannot reclassify a live dispatch as unknown", async t => {
  const f = fixture(t), first = f.open();
  await accept(first, "live", "still running");
  await first.call("dispatch", { workspaceId: "project", inputId: "live" });
  await assert.rejects(f.open().call("draftGet", scope), { code: "INPUT_STORE_IN_USE" });
  assert.equal((await first.call("get", { workspaceId: "project", inputId: "live" })).state, "dispatching");
});
