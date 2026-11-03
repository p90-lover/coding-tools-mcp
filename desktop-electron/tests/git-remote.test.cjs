"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readBranch, readGitInfo, readRemote, repoSlug, gitPushRequest, reviewRemoteIdentity, readReviewRepository } = require("../electron/git-remote.cjs");

const HAS_GIT = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("publication parsing distinguishes a planned action from quoted diagnostic text", () => {
  assert.equal(gitPushRequest('rg "why git push origin main is denied" docs'), null);
  assert.equal(gitPushRequest('echo "git push origin main"'), null);
  assert.equal(gitPushRequest('git log --grep="git push origin main"'), null);
  assert.equal(gitPushRequest('rg "git push origin main" docs'), null);
  assert.equal(gitPushRequest('node -e "console.log(\'git push origin main\')"'), null);
  assert.equal(gitPushRequest('python -c "print(\'git push origin main\')"'), null);
  assert.equal(gitPushRequest('command · Bash · echo "git push origin main"'), null);
  assert.equal(gitPushRequest('permission · mcp__coding-tools__exec_command · ' + JSON.stringify({ cmd: 'rg "why git push origin main is denied" docs' })), null);
  for (const command of ['git push origin feat/fix', 'git -c credential.helper= -c "credential.helper=!gh auth git-credential" push origin refs/heads/feat/fix:refs/heads/feat/fix']) {
    const request = gitPushRequest(command);
    assert.equal(request.status, "review", command);
    assert.equal(request.remote, "origin");
    assert.deepEqual(request.destinations, ["feat/fix"]);
  }
});

test("wrapped, escaped and absolute Git publications stay fail-closed in command and tool inputs", () => {
  const commands = [
    'bash -lc "git push origin main"',
    'sh -c "git push origin feat/fix"',
    'cmd.exe /d /s /c "git push --force origin feat/fix"',
    'powershell -NoProfile -Command "git push origin HEAD:master"',
    'env GIT_TERMINAL_PROMPT=0 git push origin main',
    'GIT_TERMINAL_PROMPT=0 git push --delete origin feat/fix',
    '\\git push origin main',
    'g\\it push origin feat/fix',
    'git p\\ush origin main',
    'bash -lc "g\\it p\\ush origin main"',
    '/usr/bin/git push origin main',
    '"C:/Program Files/Git/cmd/git.exe" push --mirror origin',
    'node -e "require(\'child_process\').execSync(\'git push origin main\')"',
    'python -c "import os; os.system(\'git push --delete origin feat/fix\')"',
    'pwsh -Command "Invoke-Expression \'git push origin main\'"',
    'Invoke-Expression "git push origin main"',
    'iex "git push origin feat/fix"',
    'eval "git push --force origin feat/fix"',
    'call git push origin main',
    '& { git push origin main }',
    '{ git push origin main; }',
    '(git push origin feat/fix)',
    'node -e "console.log(\'git push origin main\'); require(\'child_process\').execSync(\'git push origin main\')"',
    'echo "$(git push origin main)"',
    'time git push origin main',
    'nice -n 10 git push origin main',
    'custom-runner -- git push origin main',
    'node lookup.cjs query "why git push origin main is denied"',
    'rg --pre "git push origin main" needle file',
    'rg needle --pre="git push origin main" file',
    'echo (git push origin main)',
    "Write-Output ([scriptblock]::Create('git push origin main').Invoke())",
    'git -c "alias.publish=!git push origin main" publish',
  ];
  for (const command of commands) {
    for (const input of [command, JSON.stringify({ command }), JSON.stringify({ cmd: command }), 'command · Bash · ' + command,
      'permission · mcp__coding-tools__exec_command · ' + JSON.stringify({ cmd: command }),
      'permission · mcp__coding-tools__exec_command · input ' + JSON.stringify({ cmd: command })]) {
      const request = gitPushRequest(input);
      assert.ok(request && request.status !== "review", command + " cannot bypass publication checks");
    }
  }
});

test("known shells preserve passive diagnostics and protected publication classification", () => {
  for (const command of [
    'bash -lc "git push origin main"',
    'pwsh -Command "git push origin main"',
    'cmd /c "git push origin main"',
  ]) assert.equal(gitPushRequest(command)?.status, "blocked", command);
  for (const command of [
    `bash -lc 'printf "%s\\n" "git push origin main"'`,
    `pwsh -Command "Write-Output 'git push origin main'"`,
    'cmd /c "echo git push origin main"',
  ]) assert.equal(gitPushRequest(command), null, command);
});

test("destructive and protected pushes stay blocked, ambiguous publication needs a person", () => {
  for (const command of ['git push origin main', 'git push origin HEAD:master', 'git push --force origin feat/fix', 'git push --delete origin feat/fix', 'git push --mirror origin', 'git push origin +feat/fix', 'git push origin :feat/fix', 'git push --no-verify origin feat/fix']) {
    assert.equal(gitPushRequest(command).status, "blocked", command);
  }
  assert.equal(gitPushRequest(JSON.stringify({ cmd: 'cd app\ngit push origin main' })).status, "blocked");
  for (const command of ['git push', 'git push https://other.test/team/repo feat/fix', 'git -C ../other push origin feat/fix', 'node prepare.cjs; git push origin feat/fix', 'git -c remote.origin.pushurl=https://other.test/team/repo push origin feat/fix']) {
    assert.equal(gitPushRequest(command).status, "unknown", command);
  }
});

test("review destination identities strip credentials and refuse remote helpers and query tokens", () => {
  assert.equal(reviewRemoteIdentity('https://user:PRIVATE@github.com/team/repo.git'), 'github.com/team/repo');
  assert.equal(reviewRemoteIdentity('git@github.com:team/repo.git'), 'github.com/team/repo');
  assert.equal(reviewRemoteIdentity('ssh://git@git.example:2222/group/repo.git'), 'git.example:2222/group/repo');
  for (const url of ['ext::sh -c bad', 'https://host/team/repo?token=PRIVATE', 'https://host/team/repo#PRIVATE', 'file:///tmp/other', 'not a URL']) assert.equal(reviewRemoteIdentity(url), null);
});

test("review Git facts read actual push URLs, keep multiple destinations, and fail unknown", async () => {
  const calls = [];
  const run = (_file, args, options, callback) => {
    assert.ok(options.timeout <= 3000);
    const command = args.slice(2).join(' '); calls.push(command);
    callback(null, command.startsWith('rev-parse') ? `${os.tmpdir()}\nfeat/fix\n`
      : command.startsWith('symbolic-ref') ? 'refs/remotes/origin/main\n'
        : command.includes('--push') ? 'https://user:PRIVATE@github.com/team/repo.git\nhttps://elsewhere.test/team/repo.git\n'
          : 'git@github.com:team/repo.git\n');
  };
  const result = await readReviewRepository(os.tmpdir(), 'origin', { run });
  assert.equal(result.status, 'observed');
  assert.equal(result.defaultBranch, 'main');
  assert.deepEqual(result.pushDestinations, ['github.com/team/repo', 'elsewhere.test/team/repo']);
  assert.deepEqual(result.fetchDestinations, ['github.com/team/repo']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|user:/);
  assert.ok(calls.includes('remote get-url --push --all origin'));
  assert.deepEqual(await readReviewRepository(os.tmpdir(), 'origin', { run: (_c, _a, _o, cb) => cb(new Error('failed')) }), { status: 'unknown' });
  assert.deepEqual(await readReviewRepository('relative', 'origin', { run }), { status: 'unknown' });
});

test("review facts follow local Git URL rewrites and pushurl changes without contacting a remote", { skip: !HAS_GIT }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-git-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
  const facts = () => readReviewRepository(repo, 'origin', { timeoutMs: 15000 });
  try {
    git('init', '-q', '-b', 'feat/fix');
    git('commit', '-q', '--allow-empty', '-m', 'fixture');
    git('remote', 'add', 'origin', 'https://github.com/team/repo.git');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const initial = await facts();
    assert.equal(initial.status, 'observed');
    assert.equal(initial.branch, 'feat/fix');
    assert.equal(initial.defaultBranch, 'trunk');
    assert.deepEqual(initial.pushDestinations, ['github.com/team/repo']);
    git('config', 'url.https://elsewhere.test/.pushInsteadOf', 'https://github.com/');
    assert.deepEqual((await facts()).pushDestinations, ['elsewhere.test/team/repo']);
    git('config', 'remote.origin.pushurl', 'https://third.test/team/repo.git');
    assert.deepEqual((await facts()).pushDestinations, ['third.test/team/repo']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

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
