"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

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

test("only git's own answer makes a folder \"not git\"; a slow or failing git leaves it unknown", async () => {
  // As the installed app saw it: git took 5-9 s on a busy disk at start, past the old 3 s limit.
  const seen = [];
  const timedOut = (command, args, options, callback) => { seen.push(options.timeout); const error = new Error("spawn timeout"); error.killed = true; error.signal = "SIGTERM"; callback(error, "", ""); };
  assert.equal(await readGitInfo(os.tmpdir(), { run: timedOut }), null, "a timeout is unknown, never \"none\"");
  assert.ok(seen[0] >= 15_000, `git is given time on a slow disk (${seen[0]} ms)`);
  const refused = (command, args, options, callback) => callback(Object.assign(new Error("exit 128"), { code: 128 }), "", "fatal: not a git repository (or any of the parent directories): .git\n");
  assert.deepEqual(await readGitInfo(os.tmpdir(), { run: refused }), { kind: "none", root: null, mainRepo: null, branch: null });
  const dubious = (command, args, options, callback) => callback(Object.assign(new Error("exit 128"), { code: 128 }), "", "fatal: detected dubious ownership in repository at 'G:/x'\n");
  assert.equal(await readGitInfo(os.tmpdir(), { run: dubious }), null, "another git error is unknown too");
  assert.equal(await readGitInfo(os.tmpdir(), { run: (c, a, o, callback) => callback(null, "only-one-line\n", "") }), null, "a short answer is unknown");
});

test("a project folder is told apart as Claude Code does: repository, worktree of one, folder inside one, not git, gone", { skip: !HAS_GIT }, async () => {
  // .native expands an 8.3 temp folder (a CI runner's RUNNER~1) to the long name git reports.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "project-git-")));
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
    assert.equal((await readGitInfo(`\\\\?\\${repo}`))?.kind, "repo", "a \\\\?\\ path as the service stores it, on any host");
    assert.equal(await readGitInfo("relative/path"), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a repository opened through a junction or a short name is the repository, not a folder inside it", { skip: !HAS_GIT }, async () => {
  // git names the repository by its real path, so the folder is compared where it really is.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "project-git-link-"));
  try {
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "init", "-q", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "ignore" });
    const link = path.join(base, "link");
    fs.symlinkSync(repo, link, "junction");
    assert.equal((await readGitInfo(link))?.kind, "repo");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
