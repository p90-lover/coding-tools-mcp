"use strict";
require("./support/temp-dirs.cjs");
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

// A fake headless service that lists a workspace's tasks the way the real one does: oldest first,
// a page at a time, with `total` and `next_offset`; a create answers with the task it made, which is
// always the last one.
function pagedWorld({ count = 0, maxOffset = Infinity, createAnswersTask = true } = {}) {
  const state = {
    revision: 3, lists: [], updates: [], onCreate: null, onPage: null,
    tasks: Array.from({ length: count }, (_, index) => ({ id: `task-${index + 1}`, title: `Chat ${index + 1}`, description: "", state: index % 2 ? "archived" : "backlog", clauses: [] })),
  };
  state.requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/tools/call") {
      const args = body.arguments;
      if (body.tool === "workflow_list") {
        if (args.task_id) {
          return { operation: { state: "completed", result: { ok: true, revision: state.revision, workspace_id: "ws-1", steps: [],
            task: structuredClone(state.tasks.find((task) => task.id === args.task_id) ?? null) } } };
        }
        const offset = args.offset ?? 0;
        state.lists.push(offset);
        if (offset > maxOffset) return { operation: { state: "failed", error: { code: "INVALID_ARGUMENT", message: "Invalid task ID or offset" } } };
        assert.equal(args.limit, 100);
        state.onPage?.(offset);
        const page = state.tasks.slice(offset, offset + 100).map(({ description, ...rest }) => rest);
        const next = offset + page.length;
        return { operation: { state: "completed", result: { ok: true, revision: state.revision, workspace_id: "ws-1", steps: [],
          tasks: page, total: state.tasks.length, next_offset: next < state.tasks.length ? next : null } } };
      }
      assert.equal(args.expected_revision, state.revision);
      let created = null;
      if (args.change.operation === "create") {
        created = { id: `task-${state.tasks.length + 1}`, title: args.change.title, description: args.change.description, state: "backlog", clauses: [] };
        state.tasks.push(created);
        state.onCreate?.();
      }
      state.revision += 1;
      return { operation: { state: "completed", result: { ok: true, ...(created && createAnswersTask ? { revision: state.revision, task: structuredClone(created) } : {}) } } };
    }
    if (endpoint === "/api/v1/ao/read") {
      const pending = body.run_id ? [{ id: body.run_id, workspace_id: "ws-1", revision: 1, nodes: [{ id: "lead", state: "pending", route: { model: "chatgpt-web/high" } }] }] : [];
      return { ok: true, runs: pending, team: { id: "team-1", revision: 7, worker_limit: 2 }, task_lifecycle: [] };
    }
    if (endpoint === "/api/v1/ao/update") {
      state.updates.push(body.change);
      return { ok: true, run: { id: body.change.run_id, workspace_id: "ws-1" } };
    }
    throw new Error(`unexpected ${endpoint}`);
  };
  return state;
}

function workflowFor(world, logs = []) {
  return createAgentOrchestratorWorkflow({
    requestHeadless: world.requestHeadless, findCodexExecutable: () => "D:/tools/codex.exe",
    resolveHarness: async () => { throw new Error("stop before execution"); },
    logger: { info: (...entry) => logs.push(entry), warn: (...entry) => logs.push(entry), error: (...entry) => logs.push(entry) },
  });
}

// Seen live 2026-11-11: a project with exactly 100 tasks (38 open, 62 archived) refused every new
// chat with "Couldn't find the new chat's task. Refresh the board.", and left a task behind each time.
test("a new chat starts in a project that already has 100 tasks", async () => {
  for (const count of [99, 100, 101, 250]) {
    const world = pagedWorld({ count });
    await workflowFor(world).call("chat_send", { workspaceId: "ws-1", message: "fix the provider manager" });
    assert.equal(world.tasks.length, count + 1, `${count}: one task is created, not one per try`);
    assert.equal(world.updates.length, 1, `${count}: the chat's run is created`);
    assert.ok(JSON.stringify(world.updates[0]).includes(`"task-${count + 1}"`), `${count}: the run belongs to the new task`);
  }
});

test("a new chat finds its own task when another chat starts in the project at the same moment", async () => {
  const world = pagedWorld({ count: 5 });
  // Another chat's task lands right after this one's: listing before and after finds two new tasks.
  world.onCreate = () => { world.onCreate = null; world.tasks.push({ id: "task-other", title: "Someone else's chat", description: "", state: "backlog", clauses: [] }); world.revision += 1; };
  // The fake checks expected_revision, so that bump is undone for this chat's own later writes.
  const original = world.requestHeadless;
  world.requestHeadless = async (endpoint, body) => {
    if (endpoint === "/api/v1/tools/call" && body.tool === "workflow_update") body.arguments.expected_revision = world.revision;
    return original(endpoint, body);
  };
  await workflowFor(world).call("chat_send", { workspaceId: "ws-1", message: "first" });
  assert.ok(JSON.stringify(world.updates[0]).includes('"task-6"'), "its own task, not the other chat's");
});

test("a service that answers a create without the task still works by listing, as before", async () => {
  const world = pagedWorld({ count: 120, createAnswersTask: false });
  await workflowFor(world).call("chat_send", { workspaceId: "ws-1", message: "older service" });
  assert.ok(JSON.stringify(world.updates[0]).includes('"task-121"'), "found on the second page of the list");
});

test("the board lists every task of a project, not the first 100", async () => {
  const world = pagedWorld({ count: 250 });
  const listed = await workflowFor(world).call("board", { workspaceId: "ws-1" });
  assert.equal(listed.tasks.length, 250);
  assert.deepEqual(world.lists, [0, 100, 200]);
  assert.equal(listed.tasks.at(-1).id, "task-250", "the newest task is the last one, and it is there");
  assert.equal(new Set(listed.tasks.map((task) => task.id)).size, 250, "no task twice");
  assert.equal(listed.truncated, undefined);
  // A project within one page costs one read, as before.
  const small = pagedWorld({ count: 100 });
  assert.equal((await workflowFor(small).call("board", { workspaceId: "ws-1" })).tasks.length, 100);
  assert.deepEqual(small.lists, [0]);
});

test("a board that changes between pages is read again from the start", async () => {
  const world = pagedWorld({ count: 150 });
  let changed = false;
  // Another chat archives a task while the second page is being read.
  world.onPage = (offset) => { if (offset === 100 && !changed) { changed = true; world.revision += 1; world.tasks[0].state = "archived"; } };
  const listed = await workflowFor(world).call("board", { workspaceId: "ws-1" });
  assert.deepEqual(world.lists, [0, 100, 0, 100], "pages of two revisions are not joined");
  assert.equal(listed.tasks.length, 150);
  assert.equal(listed.revision, 4);
  assert.equal(listed.tasks[0].state, "archived");
});

test("an older service that refuses a far offset gives a list that says it is cut short", async () => {
  const logs = [];
  const world = pagedWorld({ count: 450, maxOffset: 256 });
  const listed = await workflowFor(world, logs).call("board", { workspaceId: "ws-1" });
  assert.equal(listed.tasks.length, 300, "every page the service allows");
  assert.equal(listed.truncated, true);
  assert.ok(logs.some(([event, detail]) => event === "ao.board_list_truncated" && detail.listed === 300 && detail.total === 450));
});
