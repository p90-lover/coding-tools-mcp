"use strict";
// A project's git remote for the chat list's project card ("owner/repo", as Codex shows it).
// Only that short name leaves this module: a remote URL can carry credentials
// (https://user:token@host/...), so the URL itself is never returned.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

/** "owner/repo" from an https, ssh or scp-style git URL; null when it has no such path. */
function repoSlug(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  let pathname;
  const scp = /^[\w.-]+@[\w.-]+:(?!\/\/)(.+)$/.exec(text);
  if (scp) pathname = scp[1];
  else {
    try { pathname = new URL(text).pathname; } catch { return null; }
  }
  const parts = pathname.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const slug = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(slug) ? slug : null;
}

/** A read-only git command's output in an existing absolute folder, or null on any failure. */
function gitOutput(folder, args, { run = execFile, timeoutMs = 3000 } = {}) {
  if (typeof folder !== "string" || folder.length > 4096 || !path.isAbsolute(folder)) return Promise.resolve(null);
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Windows can refuse the process outright ("spawn UNKNOWN" under memory pressure): execFile
    // then throws instead of calling back, which failed the whole IPC call.
    try {
      run("git", ["-C", folder, ...args], { windowsHide: true, timeout: timeoutMs }, (error, stdout) => resolve(error ? null : String(stdout)));
    } catch { resolve(null); }
  });
}

const GIT_INFO_TIMEOUT_MS = 15_000;

/** A read-only git command's outcome: its output, or whether and why it failed (stderr; a timeout has none). */
function gitResult(folder, args, { run = execFile, timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    try {
      run("git", ["-C", folder, ...args], { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
    } catch (error) { resolve({ ok: false, stdout: "", stderr: String(error?.message ?? error) }); }
  });
}

/** The origin remote of an existing local folder as "owner/repo", or null (no git, no origin). */
async function readRemote(folder, options) {
  return repoSlug(await gitOutput(folder, ["remote", "get-url", "origin"], options));
}

/** The folder's checked-out branch ("main"), or null when it isn't a repo or HEAD is detached. */
async function readBranch(folder, options) {
  const name = (await gitOutput(folder, ["rev-parse", "--abbrev-ref", "HEAD"], options))?.trim();
  return name && name !== "HEAD" && /^[\w./-]{1,200}$/.test(name) ? name : null;
}

const samePath = (left, right) => {
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(left).toLowerCase() === norm(right).toLowerCase() : norm(left) === norm(right);
};

/**
 * What a project folder is in git, as Claude Code tells a project's repo from its worktrees:
 * "repo" (the folder is a repository's root), "worktree" (a linked worktree; `mainRepo` is the
 * repository it belongs to), "inside" (a folder inside the repository at `root`), "none" (not in
 * a git repository) or "missing" (the folder is gone). `branch` is the checked-out branch, null
 * when detached. Null when git could not tell (it timed out or failed otherwise), so the list shows
 * no label rather than a wrong one. One read-only `git rev-parse`; nothing is changed.
 */
async function readGitInfo(folder, options) {
  if (typeof folder !== "string" || folder.length > 4096) return null;
  // The service may store a Windows verbatim path (\\?\C:\...): drop the prefix before judging it,
  // since only Windows reads the prefixed spelling as absolute.
  const local = folder.replace(/^\\\\\?\\/, "");
  if (!path.isAbsolute(local)) return null;
  if (!fs.statSync(local, { throwIfNoEntry: false })?.isDirectory()) return { kind: "missing", root: null, mainRepo: null, branch: null };
  // Git on a busy hard disk took 5-9 s here at app start; the short default timed out and a real
  // repository read as "not git". Only git saying so means "none"; any other failure is unknown (null).
  const result = await gitResult(local, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
    { timeoutMs: GIT_INFO_TIMEOUT_MS, ...options });
  if (!result.ok) return /not a git repository/i.test(result.stderr) ? { kind: "none", root: null, mainRepo: null, branch: null } : null;
  const [root, gitDir, commonDir, head] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!root || !gitDir || !commonDir) return null;
  const branch = head && head !== "HEAD" && /^[\w./-]{1,200}$/.test(head) ? head : null;
  const toNative = (value) => path.resolve(value);
  if (!samePath(gitDir, commonDir)) {
    // A linked worktree: its git dir is <main>/.git/worktrees/<name>; the main checkout holds <main>/.git.
    const common = toNative(commonDir);
    const mainRepo = path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : common;
    return { kind: "worktree", root: toNative(root), mainRepo, branch };
  }
  return { kind: samePath(root, local) ? "repo" : "inside", root: toNative(root), mainRepo: null, branch };
}

module.exports = { readBranch, readGitInfo, readRemote, repoSlug };
