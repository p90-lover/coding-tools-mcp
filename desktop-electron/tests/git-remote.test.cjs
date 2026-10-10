"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { readRemote, repoSlug } = require("../electron/git-remote.cjs");

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
