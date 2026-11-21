"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const source = fs.readFileSync(path.resolve(__dirname, "../src/features/chat-input-client.ts"), "utf8");
const client = {};
vm.runInNewContext(
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText,
  { exports: client, crypto: require("node:crypto"), setTimeout, clearTimeout }
);

test("createUuid produces valid RFC 4122 v4 UUIDs", () => {
  const id1 = client.createUuid();
  const id2 = client.createUuid();
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(id1, id2);
});

test("pending pages reveal later saved inputs after abrupt journal worker exit", async t => {
  const { Worker } = require("node:worker_threads");
  const { createChatInputService } = require("../electron/chat-input-service.cjs");
  const { createChatInputStore } = require("../electron/chat-input-store.cjs");
  const parent = path.resolve(__dirname, "../../aiTemp/chat-input-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "paging-"));
  let worker;
  const open = () => {
    const store = createChatInputStore({ file: path.join(root, "inputs.sqlite"), attachmentsRoot: path.join(root, "attachments"),
      createWorker: (entry, options) => (worker = new Worker(entry, options)) });
    return { service: createChatInputService({ store }), store };
  };
  let { service, store } = open();
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = "ws1", key = "composer";
  const save = (inputId, scope = {}) => service.call({ action: "accept", workspaceId, key, ...scope, inputId, mode: "send",
    payload: { text: "same input text", attachments: [], annotations: [] }, destination: { taskId: "chat", message: "same input text" } });
  for (let i = 1; i <= 26; i++) await save(`input-${i}`);
  await save("other-composer", { key: "other" });
  await save("other-workspace", { workspaceId: "ws2" });
  const claimed = await store.call("dispatch", { workspaceId, inputId: "input-26" });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.state, "dispatching");
  await worker.terminate();
  await service.close();
  ({ service } = open());

  const moduleCall = (operation, args) => {
    assert.equal(operation, "chat_input");
    assert.equal(args.action, "pending");
    return service.call(args);
  };
  const first = await client.chatInputPending(moduleCall, workspaceId, key);
  assert.deepEqual(Array.from(first.items, item => item.inputId), Array.from({ length: 25 }, (_, i) => `input-${i + 1}`));
  assert.equal(first.hasMore, true);
  const second = await client.chatInputPending(moduleCall, workspaceId, key, first.cursor);
  assert.deepEqual(Array.from(second.items, item => [item.inputId, item.state]), [["input-26", "unknown"]]);
  assert.ok(second.cursor > first.cursor);
  assert.equal(second.hasMore, false);
  assert.deepEqual(Array.from((await client.chatInputPending(moduleCall, workspaceId, key)).items, item => item.inputId), Array.from(first.items, item => item.inputId));
  assert.equal((await service.get(workspaceId, "input-26")).state, "unknown");
});

test("pending pages reject non-advancing cursors, mismatched scope and duplicate input identity", async () => {
  const record = { inputId: "queued", workspaceId: "ws1", key: "composer", mode: "send", state: "queued", destination: { message: "fixture" } };
  const page = { ok: true, items: [record], hasMore: true, cursor: 26 };
  const read = response => client.chatInputPending(async () => response, "ws1", "composer", 25);
  assert.equal((await read(page)).cursor, 26);
  for (const malformed of [{ ...page, cursor: 25 }, { ...page, hasMore: undefined }, { ...page, items: [] },
    { ...page, items: [{ ...record, key: "other" }] }, { ...page, items: [record, record] }]) {
    await assert.rejects(read(malformed), { code: "INPUT_RECEIPT_INVALID" });
  }
  await assert.rejects(client.chatInputPending(() => assert.fail("invalid cursor must not issue an RPC"), "ws1", "composer", -1), { code: "INPUT_RECEIPT_INVALID" });
});

test("buildAcceptDestination enforces whitelist and validates message", () => {
  const valid = client.buildAcceptDestination({
    message: "hello world",
    taskId: "task-1",
    title: "My Task",
    goal: "Win",
    executionMode: "single",
    singleRoute: { model: "claude" },
    teamId: "team-1",
    teamRevision: 3,
    executable: "bun",
    restart: false,
    rewind: ["msg1"],
  });
  assert.equal(valid.message, "hello world");
  assert.equal(valid.taskId, "task-1");
  assert.equal(valid.teamRevision, 3);

  // Rejects invalid message
  assert.throws(() => client.buildAcceptDestination({ message: "" }), { code: "INPUT_INVALID" });
  assert.throws(() => client.buildAcceptDestination({ message: "   " }), { code: "INPUT_INVALID" });
  assert.throws(() => client.buildAcceptDestination({ message: "x".repeat(8193) }), { code: "INPUT_INVALID" });

  // Rejects unallowed properties
  assert.throws(
    () => client.buildAcceptDestination({ message: "hello", unallowedProp: "leak" }),
    { code: "INPUT_INVALID" }
  );
});

test("rebuildAttachmentMessage replaces local paths with persisted blob paths", () => {
  const message = "Check this screenshot:\n\nAttached image: C:\\temp\\shot.png\n\nAttached file: C:\\code\\test.ts";
  const orig = [
    { name: "shot.png", path: "C:\\temp\\shot.png", image: true },
    { name: "test.ts", path: "C:\\code\\test.ts", image: false },
  ];
  const persisted = [
    { name: "shot.png", path: "G:\\storage\\blobs\\shot-blob.png", image: true },
    { name: "test.ts", path: "G:\\storage\\blobs\\test-blob.ts", image: false },
  ];
  const updated = client.rebuildAttachmentMessage(message, orig, persisted);
  assert.equal(
    updated,
    "Check this screenshot:\n\nAttached image: G:\\storage\\blobs\\shot-blob.png\n\nAttached file: G:\\storage\\blobs\\test-blob.ts"
  );
});

test("chatInputDraftGet and chatInputDraftSave interact with moduleCall", async () => {
  const calls = [];
  const fakeModuleCall = async (op, args) => {
    calls.push({ op, args });
    if (args.action === "draft_get") {
      return { ok: true, revision: 1, draft: { text: "saved text", attachments: [], annotations: [] }, updatedAt: 12345 };
    }
    if (args.action === "draft_save") {
      return { ok: true, revision: 2, draft: args.draft, updatedAt: 12346 };
    }
    return { ok: false };
  };

  const got = await client.chatInputDraftGet(fakeModuleCall, "ws1", "comp1");
  assert.equal(got.revision, 1);
  assert.equal(got.draft.text, "saved text");

  const saved = await client.chatInputDraftSave(fakeModuleCall, "ws1", "comp1", 1, "mut1", { text: "new text", attachments: [], annotations: [] });
  assert.equal(saved.revision, 2);
  assert.equal(saved.draft.text, "new text");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].op, "chat_input");
  assert.equal(calls[0].args.action, "draft_get");
  assert.equal(calls[1].args.action, "draft_save");
});

test("chatInputAccept validates destination and commits acceptance receipt", async () => {
  let acceptedCall = null;
  const fakeModuleCall = async (op, args) => {
    if (args.action === "accept") {
      acceptedCall = args;
      return {
        ok: true,
        inputId: args.inputId,
        state: "queued",
        payload: args.payload,
        destination: args.destination,
        draft: { revision: (args.draftRevision ?? 0) + 1, draft: null, updatedAt: Date.now() },
      };
    }
    return { ok: false };
  };

  const receipt = await client.chatInputAccept(fakeModuleCall, "ws1", {
    key: "comp1",
    inputId: "uuid-1",
    mode: "send",
    draftRevision: 2,
    payload: { text: "send me", attachments: [], annotations: [] },
    destination: { message: "send me", taskId: "t1" },
  });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.inputId, "uuid-1");
  assert.equal(receipt.state, "queued");
  assert.equal(receipt.draft.revision, 3);
  assert.equal(acceptedCall.action, "accept");
  assert.equal(acceptedCall.inputId, "uuid-1");
});

test("DraftCoalescer coalesces typing and serializes saves per revision", async () => {
  const saves = [];
  let currentRevision = 0;
  const fakeModuleCall = async (op, args) => {
    if (args.action === "draft_save") {
      saves.push({ ...args });
      currentRevision = args.expectedRevision + 1;
      return { ok: true, revision: currentRevision, draft: args.draft, updatedAt: Date.now() };
    }
    return { ok: false };
  };

  const statuses = [];
  const coalescer = new client.DraftCoalescer({
    key: "comp1",
    workspaceId: "ws1",
    moduleCall: fakeModuleCall,
    debounceMs: 50,
    maxWaitMs: 100,
    onStatusChange: (status) => statuses.push(status),
  });

  coalescer.setKnownRevision(0);

  // Type change 1
  coalescer.queueChange({ text: "h", attachments: [], annotations: [] });
  assert.equal(coalescer.getStatus(), "saving");

  // Immediate flush
  await coalescer.flush();
  assert.equal(coalescer.getStatus(), "saved");
  assert.equal(saves.length, 1);
  assert.equal(saves[0].expectedRevision, 0);
  assert.equal(coalescer.getKnownRevision(), 1);

  // Type change 2
  coalescer.queueChange({ text: "hello", attachments: [], annotations: [] });
  await coalescer.flush();
  assert.equal(coalescer.getStatus(), "saved");
  assert.equal(saves.length, 2);
  assert.equal(saves[1].expectedRevision, 1);
  assert.equal(coalescer.getKnownRevision(), 2);

  coalescer.dispose();
});

test("DraftCoalescer does not rewrite unchanged data after canonical key reordering", async () => {
  let saves = 0;
  const writer = new client.DraftCoalescer({ key: "one", workspaceId: "project", moduleCall: async (_op, args) => {
    saves += 1;
    return { ok: true, revision: saves, draft: { annotations: args.draft.annotations, attachments: args.draft.attachments, text: args.draft.text }, updatedAt: 1 };
  } });
  const draft = { text: "unchanged", attachments: [], annotations: [] };
  writer.queueChange(draft); await writer.flush();
  assert.equal(writer.matchesSaved(draft), true);
  writer.queueChange({ ...draft }); await writer.flush();
  assert.equal(saves, 1);
  await writer.dispose();
});

test("receipt validation never invents an acknowledged revision", () => {
  assert.throws(() => client.readAcceptReceipt({ ok: true, inputId: "one", state: "queued", payload: { text: "a", attachments: [], annotations: [] }, destination: { message: "a" } }, "one"), /durable input receipt/);
  assert.throws(() => client.readDraftReceipt({ revision: -1, draft: null }), /durable input receipt/);
});

test("attachment receipt cannot replace a different file attached during a save", () => {
  const original = [{ name: "a.png", path: "/selected/a.png", image: true }];
  const preserved = [{ name: "a.png", path: "/owned/hash", image: true, blobId: "hash" }];
  const current = [{ name: "b.png", path: "/selected/b.png", image: true }];
  assert.equal(client.mergePersistedAttachments(current, original, preserved), current);
  assert.equal(client.sameAttachmentSnapshot(current, original, preserved), false);
  assert.equal(client.sameAttachmentSnapshot(preserved, original, preserved), true);
  assert.equal(client.rebuildAttachmentMessage("Attached image: /selected/a.png.other", original, preserved), "Attached image: /selected/a.png.other");
});

test("DraftCoalescer retries a lost response with the exact mutation identity", async () => {
  const calls = [];
  const writer = new client.DraftCoalescer({ key: "chat", workspaceId: "project", moduleCall: async (_op, args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error("reply lost");
    return { ok: true, revision: 1, draft: args.draft, updatedAt: 1, duplicate: true };
  } });
  writer.queueChange({ text: "saved once", attachments: [], annotations: [] });
  await writer.flush();
  assert.equal(writer.getStatus(), "unsaved");
  await writer.flush();
  assert.equal(calls[1].mutationId, calls[0].mutationId);
  assert.equal(calls[1].expectedRevision, calls[0].expectedRevision);
  assert.equal(writer.getStatus(), "saved");
  await writer.dispose();
});

test("DraftCoalescer flush waits for in-flight work and newest typing", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const writer = new client.DraftCoalescer({ key: "one", workspaceId: "project", moduleCall: async (_op, args) => {
    calls.push(args);
    if (calls.length === 1) await gate;
    return { ok: true, revision: args.expectedRevision + 1, draft: args.draft, updatedAt: 1 };
  } });
  writer.queueChange({ text: "first", attachments: [], annotations: [] });
  const first = writer.flush();
  writer.queueChange({ text: "new typing", attachments: [], annotations: [] });
  let settled = false;
  const second = writer.flush().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release(); await first; await second;
  assert.equal(calls.length, 2); assert.equal(calls[1].draft.text, "new typing");
  assert.equal(calls[1].expectedRevision, 1);
  await writer.dispose();
});

test("DraftCoalescer defers newer typing until acceptance returns its revision", async () => {
  const calls = [];
  const writer = new client.DraftCoalescer({ key: "one", workspaceId: "project", moduleCall: async (_op, args) => {
    calls.push(args);
    return { ok: true, revision: args.expectedRevision + 1, draft: args.draft, updatedAt: 1 };
  } });
  const original = { text: "submitted", attachments: [], annotations: [] };
  writer.setKnownRevision(1, JSON.stringify(original));
  const release = writer.pauseForAcceptance();
  writer.queueChange({ text: "newer typing", attachments: [], annotations: [] });
  const waiting = writer.flush();
  await Promise.resolve(); assert.equal(calls.length, 0);
  release({ revision: 2, draft: null, updatedAt: 1 }, original);
  await waiting;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedRevision, 2);
  assert.equal(calls[0].draft.text, "newer typing");
  assert.equal(writer.getKnownRevision(), 3);
  await writer.dispose();
});

test("DraftCoalescer does not restore the submitted snapshot after acceptance cleared it", async () => {
  let calls = 0;
  const writer = new client.DraftCoalescer({ key: "one", workspaceId: "project", moduleCall: async () => { calls += 1; throw new Error("must not save again"); } });
  const original = { text: "submitted", attachments: [], annotations: [] };
  writer.setKnownRevision(1, JSON.stringify(original));
  const release = writer.pauseForAcceptance();
  writer.queueChange(original);
  release({ revision: 2, draft: null, updatedAt: 1 }, original);
  await writer.flush();
  assert.equal(calls, 0);
  assert.equal(writer.matchesSaved(null), true);
  await writer.dispose();
});

test("DraftCoalescer handles conflict without overwriting", async () => {
  let conflictReported = null;
  const fakeModuleCall = async () => ({
    ok: true,
    conflict: true,
    conflictId: "conflict-123",
    revision: 5,
    draft: { text: "server text", attachments: [], annotations: [] },
  });

  const coalescer = new client.DraftCoalescer({
    key: "comp1",
    workspaceId: "ws1",
    moduleCall: fakeModuleCall,
    debounceMs: 50,
    maxWaitMs: 100,
    onConflict: (c) => { conflictReported = c; },
  });

  coalescer.setKnownRevision(2);
  coalescer.queueChange({ text: "local text", attachments: [], annotations: [] });
  await coalescer.flush();

  assert.equal(coalescer.getStatus(), "unsaved");
  assert.equal(coalescer.getKnownRevision(), 5);
  assert.notEqual(conflictReported, null);
  assert.equal(conflictReported.conflictId, "conflict-123");

  coalescer.dispose();
});
