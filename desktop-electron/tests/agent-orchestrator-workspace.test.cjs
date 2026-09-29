const assert = require("node:assert/strict");
const test = require("node:test");
const { createAoWorkspaceBoard } = require("../electron/agent-orchestrator-workspace.cjs");

function fixture(projects = [{ id: "project-a", path: "C:\\work\\a" }], repository = true) {
  const calls = [];
  const bridge = createAoWorkspaceBoard({
    platform: "win32", realpath: async value => value,
    isRepositoryRoot: async () => repository,
    listWorkspaces: async () => [{ id: "workspace-a", path: "C:\\work\\A" }, { id: "workspace-b", path: "C:\\work\\b" }],
    listProjects: async () => projects,
    createProject: async body => { calls.push(["project", body]); const project = { id: "created", path: body.path }; projects.push(project); return project; },
    missionCall: async (operation, args) => {
      calls.push([operation, args]);
      return operation === "runs" ? { ok: true, runs: [{ id: "run-a", workspace_id: args.workspaceId, project_id: "task-a", revision: 3, nodes: [] }] }
        : { ok: true, revision: 7, tasks: [{ id: "task-a", title: "A real task" }] };
    },
  });
  return { bridge, calls, projects };
}

test("AO project binding uses the canonical workspace path and keeps mission IDs unchanged", async () => {
  const { bridge, calls } = fixture();
  assert.deepEqual(await bridge.bind("workspace-a"), { workspaceId: "workspace-a", projectId: "project-a" });
  const board = await bridge.read("project-a");
  assert.equal(board.projectId, "project-a");
  assert.equal(board.workspaceId, "workspace-a");
  assert.equal(board.runs[0].id, "run-a");
  assert.equal(board.tasks[0].id, "task-a");
  assert.deepEqual(calls.map(call => call[0]), ["board", "runs"]);
  assert.ok(calls.every(call => call[1].workspaceId === "workspace-a"));
});

test("binding the same unbound workspace concurrently registers one AO project without a worktree or model launch", async () => {
  const { bridge, calls } = fixture([]);
  const [first, second] = await Promise.all([bridge.bind("workspace-a"), bridge.bind("workspace-a")]);
  assert.deepEqual(first, second);
  assert.deepEqual(calls, [["project", { path: "C:\\work\\A" }]]);
  const local = fixture([], false);
  assert.deepEqual(await local.bridge.bind("workspace-a"), { workspaceId: "workspace-a", projectId: null });
  assert.equal(local.calls.length, 0);
  assert.equal((await local.bridge.readWorkspace("workspace-a")).runs[0].id, "run-a");
});

test("AO board rejects unknown, ambiguous, or unregistered scopes", async () => {
  const { bridge, projects, calls } = fixture();
  await assert.rejects(bridge.bind("foreign"), /registered/);
  await assert.rejects(bridge.read("foreign"), /project/);
  projects.push({ id: "foreign", path: "C:\\private" });
  await assert.rejects(bridge.read("foreign"), /registered/);
  projects.push({ id: "duplicate", path: "C:\\WORK\\a" });
  await assert.rejects(bridge.bind("workspace-a"), /multiple/);
  assert.equal(calls.length, 0);
});
