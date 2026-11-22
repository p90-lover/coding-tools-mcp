"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");
const { createChatInputService } = require("../electron/chat-input-service.cjs");

function world(t, journal) {
  const calls = [], timers = [];
  const workflow = createAgentOrchestratorWorkflow({
    inputJournal: journal,
    findCodexExecutable: () => "fixture-codex", exists: () => true,
    setTimer: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, clearTimer() {},
    requestHeadless: async (endpoint, body) => {
      calls.push([endpoint, body]);
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [{ id: "run", workspace_id: "project", project_id: "task", cancelled: false,
        nodes: [{ id: "node", role: "planner", state: "running", route: { harness_id: "ao:codex" }, receipt: { thread_id: "session", turn_id: "turn" } }] }], task_lifecycle: [] };
      throw new Error(`Unexpected fixture route: ${endpoint}`);
    },
  });
  t.after(() => workflow.dispose());
  return { workflow, calls, timers };
}
const journalStub = extra => ({ pending: async () => ({ items: [], hasMore: false }), saved: async () => {}, ...extra });
const queueArgs = { workspaceId: "project", taskId: "task" };

async function until(fn, expected) {
  for (let count = 0; count < 100; count += 1) {
    const value = await fn();
    if (expected(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Fixture did not settle");
}

test("input workflow routes durable actions and does not close the host-owned journal on backend disposal", async t => {
  let closed = 0, saved = 0;
  const requests = [];
  const { workflow, calls } = world(t, journalStub({ call: async args => { requests.push(args); return { ok: true, revision: 1 }; }, close: async () => { closed += 1; }, saved: async () => { saved += 1; } }));
  assert.deepEqual(await workflow.call("chat_input", { workspaceId: "project", key: "composer", action: "draft_get" }), { ok: true, revision: 1 });
  assert.equal(requests[0].action, "draft_get");
  await workflow.chatEditsSaved();
  workflow.dispose();
  assert.equal(saved, 1); assert.equal(closed, 0); assert.equal(calls.length, 0);
});

test("input workflow sends saved IDs through the journal before any model dispatch", async t => {
  const dispatches = [];
  const { workflow, calls } = world(t, journalStub({ dispatch: async (args, execute, options) => {
    dispatches.push({ args, execute, options });
    return { ok: true, taskId: "task", runId: "saved-run" };
  } }));
  const args = { ...queueArgs, inputId: "accepted-input", message: "exact message" };
  assert.equal((await workflow.call("chat_send", args)).runId, "saved-run");
  await workflow.call("chat_steer", args);
  assert.equal(dispatches[0].args.inputId, "accepted-input");
  assert.equal(dispatches[0].options.steer, false);
  assert.equal(dispatches[1].options.steer, true);
  assert.equal(calls.length, 0);
});

test("input workflow queues only the saved destination and refuses mutation or uncertain removal", async t => {
  const cancelled = [];
  let rejectCancel = false;
  const { workflow } = world(t, journalStub({
    get: async (_workspaceId, inputId) => ({ inputId, state: "queued", destination: { taskId: "task", message: "saved message", executionMode: "single", singleRoute: { model: "saved-model" } } }),
    cancel: async (_workspaceId, inputId) => { if (rejectCancel) throw new Error("delivery unknown"); cancelled.push(inputId); },
  }));
  await assert.rejects(workflow.call("chat_queue", { ...queueArgs, action: "add", item: { inputId: "input", message: "changed" } }), /different chat or message/);
  const added = await workflow.call("chat_queue", { ...queueArgs, action: "add", item: { inputId: "input", message: "saved message" } });
  assert.equal(added.item.id, "input");
  assert.equal(added.item.inputId, "input");
  assert.equal(added.item.selection.singleRoute.model, "saved-model");
  assert.equal((await workflow.call("chat_queue", { ...queueArgs, action: "update", itemId: "input", message: "merged message" })).updated, false);
  rejectCancel = true;
  await assert.rejects(workflow.call("chat_queue", { ...queueArgs, action: "remove", ids: ["input"] }), /delivery unknown/);
  assert.equal((await workflow.call("chat_queue", { ...queueArgs, action: "list" })).queue.length, 1);
  rejectCancel = false;
  assert.equal((await workflow.call("chat_queue", { ...queueArgs, action: "remove", ids: ["input"] })).removed, 1);
  assert.deepEqual(cancelled, ["input"]);
});

test("input workflow restores a missing queue projection from durable inputs without replaying unknown delivery", async t => {
  const { workflow, timers } = world(t, journalStub({ pending: async () => ({ items: [
    { inputId: "queued", workspaceId: "project", key: "task", state: "queued", mode: "queue", destination: { taskId: "task", message: "queued message" } },
    { inputId: "unknown", workspaceId: "project", key: "other", state: "unknown", mode: "send", destination: { taskId: "other", message: "uncertain message" } },
  ], hasMore: false }) }));
  const queue = await until(() => workflow.call("chat_queue", { ...queueArgs, action: "list" }), value => value.queue.length === 1);
  assert.equal(queue.queue[0].inputId, "queued");
  const uncertain = await workflow.call("chat_queue", { workspaceId: "project", taskId: "other", action: "list" });
  assert.match(uncertain.queue[0].note, /not be replayed/);
  assert.equal(timers.length, 1, "only confirmed queued delivery is scheduled");
});

test("input workflow commits a new task and run through one atomic host operation", async t => {
  const updates = [], boardWrites = [];
  let accepted;
  const route = { harness_id: "ao:codex", provider_id: "agent-orchestrator", account_id: "ao-local", model: "fixture", permission_profile: ":ao-default" };
  const workflow = createAgentOrchestratorWorkflow({
    inputJournal: journalStub({ dispatch: async (args, execute) => execute(args) }),
    findCodexExecutable: () => "fixture-codex", exists: () => true,
    resolveHarness: async () => { throw new Error("fixture stops before execution"); },
    requestHeadless: async (endpoint, body) => {
      if (endpoint === "/api/v1/tools/call") {
        if (body.tool !== "workflow_list") boardWrites.push(body);
        return { operation: { state: "completed", result: { ok: true, revision: 4, workspace_id: "project", tasks: [] } } };
      }
      if (endpoint === "/api/v1/ao/read") return { ok: true, runs: [], team: null, teams: [] };
      if (endpoint === "/api/v1/ao/update") {
        updates.push(body.change);
        assert.equal(body.confirm, true);
        assert.equal(body.change.operation, "accept_chat_input");
        const input = body.change.input;
        if (accepted) return { ...accepted, duplicate: true };
        accepted = { ok: true, input_id: input.input_id, task_id: "accepted-task", run_id: input.run_id,
          run: { id: input.run_id, workspace_id: "project", project_id: "accepted-task", revision: 1,
            execution_mode: "single", nodes: [{ id: "one", role: "planner", state: "pending", parents: [], route }] } };
        return accepted;
      }
      throw new Error("fixture stops before external dispatch");
    },
  });
  t.after(() => workflow.dispose());
  const args = { workspaceId: "project", inputId: "saved-input", message: "hello", executionMode: "single", singleRoute: route };
  const result = await workflow.call("chat_send", args);
  assert.equal(result.taskId, "accepted-task");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].input.input_id, "saved-input");
  assert.equal(updates[0].input.expected_board_revision, 4);
  assert.equal(updates[0].input.description, "hello");
  const duplicate = await workflow.call("chat_send", args);
  assert.equal(duplicate.runId, result.runId);
  assert.equal(duplicate.status, "recovered", "An existing atomic receipt must not start a run again");
  assert.deepEqual(boardWrites, []);
});

test("native steer acceptance requires the exact durable receipt for the saved input", async t => {
  const parent = path.resolve(__dirname, "../../aiTemp/chat-input-tests");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "steer-receipt-"));
  const { workspaceId, taskId } = queueArgs;
  const sessionId = "native:session", firstTurn = "first-turn";
  const message = "same guidance", scope = { workspaceId, key: "composer" };
  const proof = inputId => ({ state: "accepted", workspaceId, sessionId, turnId: firstTurn, inputId });
  const proofs = new Map([["first", proof("first")], ["second", proof("first")]]);
  const dispatches = [], lookups = [];
  let activeTurn = firstTurn, journal, workflow;
  function open() {
    journal = createChatInputService({ file: path.join(root, "inputs.sqlite"), attachmentsRoot: path.join(root, "attachments") });
    workflow = createAgentOrchestratorWorkflow({
      inputJournal: journal,
      aoHarness: {
        async steer(session, text, inputId, target) {
          assert.equal(text, message);
          assert.equal(session, sessionId);
          assert.deepEqual(target, { workspaceId, turnId: activeTurn });
          assert.equal((await journal.get(workspaceId, inputId)).receipt?.turnId, target.turnId);
          dispatches.push(inputId);
          return inputId === "not-sent" ? { steered: false } : { steered: true, turnId: target.turnId, inputId };
        },
        async recover(sessionId, turnId, { workspaceId, inputId }) {
          lookups.push({ workspaceId, sessionId, turnId, inputId });
          return { steerReceipt: proofs.get(inputId) ?? null, replayed: false };
        },
      },
      async requestHeadless(endpoint) {
        if (endpoint !== "/api/v1/ao/read") throw new Error(`Unexpected fixture route: ${endpoint}`);
        return { ok: true, task_lifecycle: [], runs: [{ id: "run", workspace_id: workspaceId, project_id: taskId, execution_mode: "single",
          nodes: [{ id: "node", role: "planner", state: "running", route: { harness_id: "ao:orchestrator-fixture" },
            receipt: { thread_id: sessionId, turn_id: activeTurn } }] }] };
      },
    });
  }
  t.after(async () => {
    workflow?.dispose();
    await journal?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  open();
  const call = (action, fields = {}) => workflow.call("chat_input", { ...scope, action, ...fields });
  async function submit(inputId) {
    const { revision } = await call("draft_get");
    const draft = { text: message, attachments: [], annotations: [] };
    const saved = await call("draft_save", { draft, expectedRevision: revision, mutationId: `draft-${inputId}` });
    assert.equal(saved.revision, revision + 1);
    const submitted = await call("accept", { inputId, mode: "steer", draftRevision: saved.revision, payload: draft, destination: { taskId, message } });
    assert.equal(submitted.inputId, inputId);
    assert.equal(submitted.state, "queued");
    assert.equal(submitted.draft.draft, null);
    return { workspaceId, taskId, inputId, message };
  }
  const first = await submit("first"), second = await submit("second");
  assert.equal((await workflow.call("chat_steer", first)).inputId, first.inputId);
  await assert.rejects(workflow.call("chat_steer", second), { code: "NATIVE_DELIVERY_UNKNOWN" });
  assert.deepEqual(lookups.map(item => item.inputId), ["first", "second"]);
  assert.equal((await journal.get(workspaceId, first.inputId)).state, "accepted");
  assert.equal((await journal.get(workspaceId, second.inputId)).state, "unknown");

  workflow.dispose();
  await journal.close();
  activeTurn = "later-turn";
  open();
  const exact = proof(second.inputId);
  for (const invalid of [null, { ...exact, turnId: activeTurn }, { ...exact, workspaceId: "another-project" },
    { ...exact, sessionId: "native:other" }, { ...exact, state: "unknown" }]) {
    proofs.set(second.inputId, invalid);
    await assert.rejects(workflow.call("chat_steer", second), { code: "INPUT_DELIVERY_UNKNOWN" });
    assert.equal((await journal.get(workspaceId, second.inputId)).state, "unknown");
  }
  proofs.set(second.inputId, exact);
  const recovered = await workflow.call("chat_steer", second);
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.inputId, second.inputId);
  assert.equal(recovered.turnId, firstTurn);
  assert.equal((await journal.get(workspaceId, second.inputId)).state, "accepted");
  assert.ok(lookups.every(item => item.workspaceId === workspaceId && item.sessionId === sessionId && item.turnId === firstTurn));
  assert.deepEqual(dispatches, ["first", "second"], "Reconciling a receipt must not send either input again");

  const unsent = await submit("not-sent");
  assert.equal((await workflow.call("chat_steer", unsent)).steered, false);
  assert.equal((await journal.get(workspaceId, unsent.inputId)).state, "queued");
});

test("input workflow removes a confirmed sent queue projection without cancelling its input", async t => {
  let state = "queued", cancellations = 0, releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  const workflow = createAgentOrchestratorWorkflow({
    inputJournal: journalStub({ get: async () => ({ inputId: "saved", state, destination: { taskId: "task", message: "hello" } }),
      cancel: async () => { cancellations += 1; throw new Error("already sent"); } }),
    requestHeadless: () => pendingRead,
    findCodexExecutable: () => "fixture-codex", setTimer: () => ({ unref() {} }), clearTimer() {},
  });
  t.after(() => { workflow.dispose(); releaseRead({ ok: true, runs: [], task_lifecycle: [] }); });
  await workflow.call("chat_queue", { ...queueArgs, action: "add", item: { inputId: "saved", message: "hello" } });
  state = "accepted";
  const result = await workflow.call("chat_queue", { ...queueArgs, action: "remove", ids: ["saved"] });
  assert.equal(result.removed, 1);
  assert.equal(cancellations, 0);
});

test("input workflow refuses saved-input dispatch when durable storage is unavailable", async t => {
  const { workflow, calls } = world(t, null);
  await assert.rejects(workflow.call("chat_send", { ...queueArgs, inputId: "input", message: "keep" }), /storage is unavailable/);
  assert.equal(calls.length, 0);
});
