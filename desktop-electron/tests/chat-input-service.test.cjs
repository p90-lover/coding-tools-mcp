"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createChatInputService } = require("../electron/chat-input-service.cjs");

function fixture(t) {
  const parent = path.resolve(__dirname, "../../aiTemp/chat-input-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "service-"));
  const legacyDraftsFile = path.join(root, "chat-drafts.json");
  fs.writeFileSync(legacyDraftsFile, JSON.stringify({ version: 1, drafts: { "project\u0000composer": { text: "legacy draft", attachments: [], annotations: [] } } }));
  const service = createChatInputService({ file: path.join(root, "inputs.sqlite"), attachmentsRoot: path.join(root, "attachments"), legacyDraftsFile });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, legacyDraftsFile, service };
}
const scope = { workspaceId: "project", key: "composer" };
const request = (id, mode = "send") => ({ ...scope, action: "accept", inputId: id, mode, payload: { text: "hello", attachments: [], annotations: [] },
  destination: { taskId: "task", message: "hello", executionMode: "single", singleRoute: { model: "fixture-model" } } });

test("journal bridge imports old drafts without rewriting them and reports committed revisions", async t => {
  const { service, legacyDraftsFile } = fixture(t), original = fs.readFileSync(legacyDraftsFile, "utf8");
  const read = await service.call({ ...scope, action: "draft_get" });
  assert.equal(read.draft.text, "legacy draft"); assert.equal(read.revision, 1);
  const saved = await service.call({ ...scope, action: "draft_save", expectedRevision: 1, mutationId: "edit", draft: { text: "new draft", attachments: [], annotations: [] } });
  assert.equal(saved.revision, 2);
  assert.equal(fs.readFileSync(legacyDraftsFile, "utf8"), original);
  assert.deepEqual((await service.call({ ...scope, action: "list" })).items, []);
});

test("journal bridge dispatches the accepted route once and returns its durable host receipt", async t => {
  const { service } = fixture(t);
  await service.call(request("one"));
  let executions = 0;
  const execute = async args => {
    executions += 1;
    assert.equal(args.inputId, "one"); assert.equal(args.singleRoute.model, "fixture-model");
    return { ok: true, taskId: "task", runId: "run" };
  };
  const reply = await service.dispatch({ workspaceId: "project", inputId: "one", message: "hello", singleRoute: { model: "changed-after-acceptance" } }, execute);
  assert.deepEqual(reply, { ok: true, taskId: "task", runId: "run" });
  assert.deepEqual(await service.dispatch({ workspaceId: "project", inputId: "one" }, execute), reply);
  assert.equal(executions, 1);
  await assert.rejects(service.dispatch({ workspaceId: "project", inputId: "one", message: "different" }, execute), { code: "INPUT_ID_CONFLICT" });
  await assert.rejects(service.dispatch({ workspaceId: "project", inputId: "one", taskId: "other" }, execute), { code: "INPUT_SCOPE" });
  const saved = await service.get("project", "one");
  assert.equal(saved.receipt.stage, "host-run"); assert.equal(saved.state, "accepted");
});

test("queued delivery verifies its owned attachment again before allowing execution", async t => {
  const { service, root } = fixture(t);
  const original = path.join(root, "original.txt"), bytes = "original bytes";
  fs.writeFileSync(original, bytes);
  const inputId = "with-attachment", args = { workspaceId: "project", inputId };
  const { payload } = await service.call({ ...request(inputId), payload: { text: "hello", annotations: [],
    attachments: [{ name: "original.txt", path: original }] }, destination: { taskId: "task", message: `hello\nAttached file: ${original}` } });
  const owned = payload.attachments[0].path;
  assert.notEqual(owned, original);
  fs.unlinkSync(original);
  fs.writeFileSync(owned, "modified bytes");
  await assert.rejects(service.dispatch(args, () => assert.fail("modified files may not reach execution")), { code: "ATTACHMENT_CORRUPT" });
  assert.equal((await service.get("project", inputId)).state, "queued");
  fs.writeFileSync(owned, bytes);
  const sent = await service.dispatch(args, async input => {
    assert.equal(input.inputId, inputId);
    assert.equal(input.message, `hello\nAttached file: ${owned}`);
    assert.equal(fs.readFileSync(owned, "utf8"), bytes);
    return { ok: true, taskId: "task", runId: "run" };
  });
  assert.equal(sent.runId, "run");
  assert.equal((await service.get("project", inputId)).state, "accepted");
});

test("journal bridge never retries an uncertain send and only defers a confirmed undelivered steer", async t => {
  const { service } = fixture(t);
  await service.call(request("uncertain"));
  let executions = 0;
  const fail = async () => { executions += 1; throw new Error("lost transport reply"); };
  await assert.rejects(service.dispatch({ workspaceId: "project", inputId: "uncertain" }, fail), /lost transport/);
  await assert.rejects(service.dispatch({ workspaceId: "project", inputId: "uncertain" }, fail), { code: "INPUT_DELIVERY_UNKNOWN" });
  assert.equal(executions, 1);
  await service.call(request("steer", "steer"));
  const waiting = await service.dispatch({ workspaceId: "project", inputId: "steer" }, async () => ({ ok: true, steered: false, waiting: true }), { steer: true });
  assert.equal(waiting.waiting, true);
  assert.equal((await service.get("project", "steer")).state, "queued");
  await service.dispatch({ workspaceId: "project", inputId: "steer" }, async () => ({ ok: true, steered: true, runId: "run", nodeId: "card" }), { steer: true });
  assert.equal((await service.get("project", "steer")).receipt.stage, "steer");
});

test("journal bridge reconciles a lost host receipt without another dispatch", async t => {
  const { service } = fixture(t);
  await service.call(request("lost-host-reply"));
  let executions = 0;
  const execute = async () => { executions += 1; throw new Error("response lost after host commit"); };
  await assert.rejects(service.dispatch({ workspaceId: "project", inputId: "lost-host-reply" }, execute), /response lost/);
  const args = { workspaceId: "project", inputId: "lost-host-reply" };
  const receipt = { ok: true, found: true, input_id: args.inputId, task_id: "task", run_id: "existing-run",
    run: { id: "existing-run", workspace_id: "project", project_id: "task" } };
  for (const other of [null, { ...receipt, found: false }, { ...receipt, input_id: "different-input" }, { ...receipt, run_id: "different-run" },
    { ...receipt, run: { ...receipt.run, workspace_id: "another-project" } },
    { ...receipt, task_id: "different-task", run: { ...receipt.run, project_id: "different-task" } }]) {
    await assert.rejects(service.dispatch(args, execute, { reconcile: async () => other }), { code: "INPUT_DELIVERY_UNKNOWN" });
    assert.equal((await service.get(args.workspaceId, args.inputId)).state, "unknown");
  }
  const result = await service.dispatch(args, execute, { reconcile: async identity => {
    assert.deepEqual(identity, args);
    return receipt;
  } });
  assert.equal(result.runId, "existing-run");
  assert.equal(result.status, "recovered");
  assert.equal(executions, 1);
  assert.equal((await service.get("project", "lost-host-reply")).state, "accepted");
});

test("native steer reconciliation requires the saved receiver and an accepted read-only receipt", async t => {
  const { service } = fixture(t);
  const args = { workspaceId: "project", inputId: "lost-native-reply" };
  const target = { taskId: "task", runId: "run", nodeId: "card", sessionId: "native:session", turnId: "turn" };
  await service.call(request(args.inputId, "steer"));
  await assert.rejects(service.dispatch(args, async (_input, bind) => {
    assert.deepEqual(await bind(target), { bound: true });
    await assert.rejects(bind({ ...target, turnId: "new-turn" }), { code: "INPUT_STATE_CONFLICT" });
    await assert.rejects(bind({ ...target, taskId: "other" }), { code: "INPUT_SCOPE" });
    throw new Error("native reply lost");
  }, { steer: true }), /native reply lost/);
  const bound = (await service.get(args.workspaceId, args.inputId)).receipt;
  assert.deepEqual(bound, { ...args, ...target, stage: "native-steer-target" });
  const never = () => assert.fail("receipt reconciliation must not dispatch or fall back");
  const proof = { ...args, sessionId: target.sessionId, turnId: target.turnId, state: "accepted" };
  for (const bad of [null, { ...proof, turnId: "new-turn" }, { ...proof, state: "unknown" }]) {
    await assert.rejects(service.dispatch(args, never, { reconcile: never, reconcileSteer: async () => bad }), { code: "INPUT_DELIVERY_UNKNOWN" });
  }
  assert.equal((await service.get(args.workspaceId, args.inputId)).state, "unknown");
  const recovered = await service.dispatch(args, never, { reconcile: never, reconcileSteer: async binding => {
    assert.deepEqual(binding, bound);
    return proof;
  } });
  assert.deepEqual(recovered, { ...target, inputId: args.inputId, ok: true, steered: true, status: "recovered" });
});

test("native steer deferral clears its binding only after confirmed non-delivery", async t => {
  const { service } = fixture(t);
  const args = { workspaceId: "project", inputId: "deferred-native" };
  await service.call(request(args.inputId, "steer"));
  await service.dispatch(args, async (_input, bind) => {
    await bind({ taskId: "task", runId: "run", nodeId: "card", sessionId: "native:session", turnId: "turn" });
    return { ok: true, steered: false };
  }, { steer: true });
  const saved = await service.get(args.workspaceId, args.inputId);
  assert.equal(saved.state, "queued");
  assert.equal(saved.receipt, null);
});

test("journal bridge concurrent identical sends share one in-flight dispatch", async t => {
  const { service } = fixture(t);
  await service.call(request("concurrent"));
  let executions = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const execute = async () => { executions += 1; await gate; return { ok: true, taskId: "task", runId: "run" }; };
  const a = service.dispatch({ workspaceId: "project", inputId: "concurrent" }, execute);
  const b = service.dispatch({ workspaceId: "project", inputId: "concurrent" }, execute);
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  const results = await Promise.all([a, b]);
  assert.equal(executions, 1); assert.deepEqual(results[0], results[1]);
});

test("journal bridge recovery lists are scoped and discard only unsent input", async t => {
  const { service } = fixture(t);
  await service.call(request("visible"));
  await service.call({ ...request("other"), workspaceId: "other-project" });
  await service.call({ ...request("other-composer"), key: "another-composer" });
  const list = await service.call({ ...scope, action: "pending" });
  assert.deepEqual(list.items.map(item => item.inputId), ["visible"]);
  await service.call({ workspaceId: "project", action: "cancel", inputId: "visible" });
  assert.equal((await service.call({ ...scope, action: "pending" })).items.length, 0);
  assert.equal((await service.get("project", "visible")).state, "cancelled");
  assert.equal((await service.call({ ...scope, workspaceId: "other-project", action: "pending" })).items.length, 1);
});

test("journal bridge rejects invalid destinations before recording or executing them", async () => {
  let calls = 0;
  const service = createChatInputService({ store: { call() { calls += 1; throw new Error("must not run"); } } });
  await assert.rejects(service.call({ ...request("bad"), destination: { message: "hello", providerSecret: "not-a-real-secret" } }), { code: "INPUT_INVALID" });
  await assert.rejects(service.call({ ...request("long"), destination: { message: "x".repeat(8193) } }), { code: "INPUT_INVALID" });
  assert.equal(calls, 0);
});
