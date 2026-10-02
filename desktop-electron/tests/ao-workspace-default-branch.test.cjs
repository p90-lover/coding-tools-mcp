const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { recordLocalDefaultBranch } = require("../electron/agent-orchestrator-workspace.cjs");

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();
function repo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-default-branch-"));
  git(dir, "init", "-q", "-b", branch);
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

test("a local-only repository gets its current branch recorded as AO's default, once", async () => {
  const dir = repo("work");
  await recordLocalDefaultBranch(dir);
  assert.equal(git(dir, "config", "--local", "--get", "ao.defaultBranch"), "work");
  git(dir, "checkout", "-q", "-b", "other");
  await recordLocalDefaultBranch(dir);
  assert.equal(git(dir, "config", "--local", "--get", "ao.defaultBranch"), "work", "an existing record is kept");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a repository with a remote is never changed", async () => {
  const dir = repo("main");
  git(dir, "remote", "add", "origin", "https://example.invalid/repo.git");
  await recordLocalDefaultBranch(dir);
  assert.throws(() => git(dir, "config", "--local", "--get", "ao.defaultBranch"));
  fs.rmSync(dir, { recursive: true, force: true });
});
