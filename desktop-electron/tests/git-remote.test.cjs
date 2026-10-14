"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readBranch, readGitInfo, readRemote, repoSlug } = require("../electron/git-remote.cjs");

const HAS_GIT = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("a git remote becomes owner/repo, and credentials in the URL never come back", () => {
  assert.equal(repoSlug("https://github.com/lxf746/any-auto-register.git"), "lxf746/any-auto-register");
  assert.equal(repoSlug("git@github.com:p90-lover/coding-tools-mcp.git\n"), "p90-lover/coding-tools-mcp");
  assert.equal(repoSlug("ssh://git@gitlab.example.com:2222/group/sub/project.git"), "sub/project");
  assert.equal(repoSlug("https://user:ghp_SECRET@github.com/owner/repo"), "owner/repo");
  assert.equal(repoSlug("https://github.com/owner"), null);
  assert.equal(repoSlug("not a url"), null);
});

test("only an existing absolute folder is asked, and failures read as no remote", async () => {
  const calls = [];
  const run = (command, args, options, callback) => { calls.push(args); callback(null, "https://github.com/a/b.git\n"); };
  assert.equal(await readRemote("relative/path", { run }), null);
  assert.equal(await readRemote(os.tmpdir() + "\\definitely-missing-folder-xyz", { run }), null);
  assert.equal(calls.length, 0);
  assert.equal(await readRemote(os.tmpdir(), { run }), "a/b");
  assert.deepEqual(calls[0].slice(2), ["remote", "get-url", "origin"]);
  assert.equal(await readRemote(os.tmpdir(), { run: (c, a, o, callback) => callback(new Error("no origin")) }), null);
});

test("the branch is the checked-out name; detached HEAD, odd names and failures read as none", async () => {
  const answer = (stdout) => (command, args, options, callback) => callback(null, stdout);
  assert.equal(await readBranch(os.tmpdir(), { run: answer("main\n") }), "main");
  assert.equal(await readBranch(os.tmpdir(), { run: answer("feat/codex-composer-look\n") }), "feat/codex-composer-look");
  assert.equal(await readBranch(os.tmpdir(), { run: answer("HEAD\n") }), null);
  assert.equal(await readBranch(os.tmpdir(), { run: answer("bad name; rm\n") }), null);
  assert.equal(await readBranch("relative/path", { run: answer("main\n") }), null);
  assert.equal(await readBranch(os.tmpdir(), { run: (c, a, o, callback) => callback(new Error("not a repo")) }), null);
});

test("a project folder is told apart as Claude Code does: repository, worktree of one, folder inside one, not git, gone", { skip: !HAS_GIT }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-git-")));
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdio: "ignore" });
  try {
    const repo = path.join(base, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "src", "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const tree = path.join(base, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", tree);
    const plain = path.join(base, "plain");
    fs.mkdirSync(plain);

    const same = (left, right) => assert.equal(path.resolve(left).toLowerCase(), path.resolve(right).toLowerCase());
    const main = await readGitInfo(repo);
    assert.equal(main.kind, "repo");
    assert.equal(main.branch, "main");
    same(main.root, repo);
    const worktree = await readGitInfo(tree);
    assert.equal(worktree.kind, "worktree");
    assert.equal(worktree.branch, "feat/x");
    same(worktree.mainRepo, repo);
    const inside = await readGitInfo(path.join(repo, "src"));
    assert.equal(inside.kind, "inside");
    same(inside.root, repo);
    assert.equal((await readGitInfo(plain)).kind, "none");
    assert.equal((await readGitInfo(path.join(base, "gone"))).kind, "missing");
    assert.equal((await readGitInfo(`\\\\?\\${repo}`)).kind, process.platform === "win32" ? "repo" : "missing", "a \\\\?\\ path as the service stores it");
    assert.equal(await readGitInfo("relative/path"), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
