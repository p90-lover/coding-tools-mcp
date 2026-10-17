const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { createAoWorkspaceBoard, listBranches, switchFolderBranch } = require("../electron/agent-orchestrator-workspace.cjs");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true,
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });

test("the branch bar lists every branch, its worktree, and which one the folder and the chat are on", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-branches-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "branch", "feature/one");
    const chatWorktree = path.join(root, "chat-wt");
    git(repo, "worktree", "add", "-q", "-b", "ao/chat-1", chatWorktree);

    const result = await listBranches(repo, chatWorktree);
    assert.equal(result.git, true);
    assert.equal(result.current, "main");
    assert.equal(result.chatBranch, "ao/chat-1");
    const byName = Object.fromEntries(result.branches.map((branch) => [branch.name, branch]));
    assert.deepEqual(Object.keys(byName).sort(), ["ao/chat-1", "feature/one", "main"]);
    assert.equal(byName.main.current, true);
    assert.equal(byName["ao/chat-1"].chat, true);
    assert.equal(path.resolve(byName["ao/chat-1"].worktree), path.resolve(chatWorktree));
    assert.equal(byName["feature/one"].worktree, null);
    assert.match(byName.main.updatedAt, /^\d{4}-\d\d-\d\dT/);
    // The default branch comes first and AO's session branches last.
    assert.equal(result.defaultBranch, "main");
    assert.equal(byName.main.default, true);
    assert.deepEqual(result.branches.map((branch) => branch.name), ["main", "feature/one", "ao/chat-1"]);

    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    assert.deepEqual(await listBranches(plain), { git: false, branches: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("choosing a branch checks it out in the project folder and creates nothing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-branches-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "branch", "feature/one");
    git(repo, "worktree", "add", "-q", "-b", "ao/chat-1", path.join(root, "chat-wt"));
    const branchesBefore = git(repo, "branch", "--format=%(refname:short)");

    assert.deepEqual(await switchFolderBranch(repo, "feature/one"), { switched: true });
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "feature/one");
    assert.deepEqual(await switchFolderBranch(repo, "feature/one"), { switched: false });
    assert.equal(git(repo, "branch", "--format=%(refname:short)"), branchesBefore, "no branch is created");

    // Another worktree holds it: git's own reason is passed on.
    await assert.rejects(switchFolderBranch(repo, "ao/chat-1"), /already (used|checked out)/);
    await assert.rejects(switchFolderBranch(repo, "nope"), /no local branch named nope/);
    await assert.rejects(switchFolderBranch(repo, "--orphan"), /Choose a branch/);
    fs.writeFileSync(path.join(repo, "a.txt"), "changed");
    await assert.rejects(switchFolderBranch(repo, "main"), /uncommitted changes/);
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "feature/one");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a project that never chose where chats work gets the folder before its first chat", async () => {
  const calls = [];
  const board = createAoWorkspaceBoard({
    platform: "linux", realpath: async (value) => value, isRepositoryRoot: async () => true, recordDefaultBranch: async () => {},
    listWorkspaces: async () => [{ id: "w1", path: "/repo" }],
    listProjects: async () => [], createProject: async (body) => { calls.push("create"); return { id: "p1", path: body.path }; },
    missionCall: async () => ({ ok: true }),
    defaultWorkspaceMode: async (project) => { calls.push(`mode:${project.id}`); },
    syncProject: async () => { calls.push("sync"); },
  });
  assert.deepEqual(await board.bind("w1"), { workspaceId: "w1", projectId: "p1" });
  assert.deepEqual(calls, ["create", "mode:p1", "sync"]);

  // A failed default does not stop the chat; AO falls back to its own.
  const failing = createAoWorkspaceBoard({
    platform: "linux", realpath: async (value) => value, isRepositoryRoot: async () => true, recordDefaultBranch: async () => {},
    listWorkspaces: async () => [{ id: "w1", path: "/repo" }],
    listProjects: async () => [{ id: "p1", path: "/repo" }], missionCall: async () => ({ ok: true }),
    defaultWorkspaceMode: async () => { throw new Error("AO is busy"); },
  });
  assert.deepEqual(await failing.bind("w1"), { workspaceId: "w1", projectId: "p1" });
});

test("the folder default never overrides a project's own choice, and a choice is always saved", () => {
  const upstream = fs.readFileSync(path.join(__dirname, "..", "electron", "agent-orchestrator-upstream.cjs"), "utf8");
  assert.match(upstream, /if \(config\.workspaceMode\) return;/);
  assert.match(upstream, /config: \{ \.\.\.config, workspaceMode: "folder" \}/);
  assert.match(upstream, /config: \{ \.\.\.config, workspaceMode: args\.mode \}/);
});

test("chat_branches is read-only and chat_switch_branch writes; the app handler routes both to the AO runtime", () => {
  const handler = fs.readFileSync(path.join(__dirname, "..", "..", "app-handler", "agent-orchestrator", "handler.cjs"), "utf8");
  assert.match(handler, /chat_branches: \{ readOnly: true/);
  assert.match(handler, /chat_switch_branch: \{ readOnly: false/);
  assert.match(handler, /UPSTREAM_OPERATIONS = new Set\(\[[^\]]*"chat_branches", "chat_switch_branch"/s);
});
