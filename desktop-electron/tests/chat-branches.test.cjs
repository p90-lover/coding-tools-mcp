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

test("each branch carries its tip commit and its distance from the default; the folders carry their uncommitted work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-branch-details-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    // An agent branch made from main and never committed to: same as main, with main's old tip.
    const chatWorktree = path.join(root, "chat-wt");
    git(repo, "worktree", "add", "-q", "-b", "ao/chat-1", chatWorktree);
    git(repo, "switch", "-q", "-c", "feature/two");
    fs.writeFileSync(path.join(repo, "b.txt"), "b");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "add\tb with a tab");
    git(repo, "switch", "-q", "main");
    // The project folder: one modified file (first in status, so its leading space matters), one untracked.
    fs.writeFileSync(path.join(repo, "a.txt"), "changed");
    fs.writeFileSync(path.join(repo, "new.txt"), "new");
    fs.writeFileSync(path.join(chatWorktree, "staged.txt"), "s");
    git(chatWorktree, "add", "staged.txt");

    const result = await listBranches(repo, chatWorktree);
    const byName = Object.fromEntries(result.branches.map((branch) => [branch.name, branch]));
    assert.deepEqual([byName["feature/two"].ahead, byName["feature/two"].behind], [1, 0]);
    assert.equal(byName["feature/two"].subject, "add\tb with a tab", "a subject keeps its own tab");
    assert.match(byName["feature/two"].commit, /^[0-9a-f]{7,}$/);
    assert.deepEqual([byName["ao/chat-1"].ahead, byName["ao/chat-1"].behind], [0, 0]);
    assert.equal(byName["ao/chat-1"].subject, "first");
    assert.deepEqual(result.folderChanges, { staged: 0, modified: 1, untracked: 1 });
    assert.deepEqual(result.chatChanges, { staged: 1, modified: 0, untracked: 0 });
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
  assert.match(upstream, /Boolean\(current\.config\?\.workspaceMode\)/);
  assert.match(upstream, /if \(settled\(current\)\) return;/);
  assert.match(upstream, /config: \{ \.\.\.config, workspaceMode: "folder" \}/);
  assert.match(upstream, /config: \{ \.\.\.config, workspaceMode: args\.mode \}/);
});

test("chat_branches is read-only and chat_switch_branch writes; the app handler routes both to the AO runtime", () => {
  const handler = fs.readFileSync(path.join(__dirname, "..", "..", "app-handler", "agent-orchestrator", "handler.cjs"), "utf8");
  assert.match(handler, /chat_branches: \{ readOnly: true/);
  assert.match(handler, /chat_switch_branch: \{ readOnly: false/);
  assert.match(handler, /UPSTREAM_OPERATIONS = new Set\(\[[^\]]*"chat_branches", "chat_switch_branch"/s);
});

test("a project's branches are read once for callers asking together, kept briefly, and read again after a switch", async () => {
  // Seen live: opening a project mounted two branch bars at once, each listing the branches with about
  // a dozen git processes, and starting each held the main process for 100-400 ms.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-branches-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "first");
    git(repo, "branch", "feature/one");
    let lookups = 0;
    const board = createAoWorkspaceBoard({ listWorkspaces: async () => { lookups += 1; return [{ id: "ws", path: repo }]; },
      listProjects: async () => [], createProject: async () => ({}), missionCall: async () => ({}) });
    const [first, second] = await Promise.all([board.branches("ws"), board.branches("ws")]);
    assert.equal(first, second, "two callers at once share one read");
    assert.equal(first.current, "main");
    assert.equal(await board.branches("ws"), first, "a read a moment later is the kept one");
    git(repo, "branch", "feature/two");
    assert.ok(!(await board.branches("ws")).branches.some((branch) => branch.name === "feature/two"), "still the kept read");
    const switched = await board.switchBranch("ws", "feature/one");
    assert.equal(switched.current, "feature/one");
    const after = await board.branches("ws");
    assert.notEqual(after, first, "a switch drops the kept read");
    assert.equal(after.current, "feature/one");
    assert.ok(after.branches.some((branch) => branch.name === "feature/two"));
    assert.ok(lookups >= 4, "the workspace is still looked up on every call");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
