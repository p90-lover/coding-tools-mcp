const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const { listBranches } = require("../electron/agent-orchestrator-workspace.cjs");

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

    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    assert.deepEqual(await listBranches(plain), { git: false, branches: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("chat_branches is a read-only operation the app handler routes to the AO runtime", () => {
  const handler = fs.readFileSync(path.join(__dirname, "..", "..", "app-handler", "agent-orchestrator", "handler.cjs"), "utf8");
  assert.match(handler, /chat_branches: \{ readOnly: true/);
  assert.match(handler, /UPSTREAM_OPERATIONS = new Set\(\[[^\]]*"chat_branches"/s);
});
