"use strict";
// A project's git remote for the chat list's project card ("owner/repo", as Codex shows it).
// Remote identities only leave this module: a URL can carry credentials
// (https://user:token@host/...), so the raw URL itself is never returned.
const fs = require("node:fs");
const path = require("node:path");
const { runOffThread } = require("./off-thread-run.cjs");

/**
 * execFile's callback shape, with git started from a worker thread: on Windows starting a program
 * holds the thread that starts it until it is loaded, and every project card asks git for its
 * remote, branch and kind (one held main for 2 s on the busy hard disk, 0.8.49, 2026-11-02).
 */
function execFileOffThread(file, args, { timeout } = {}, callback) {
  void runOffThread({ file, args, timeoutMs: timeout, maxBytes: 256 * 1024 }).then((reply) => {
    if (reply?.error) callback(new Error(reply.error), "", "");
    else if (reply?.timedOut) callback(Object.assign(new Error(`${file} timed out`), { killed: true }), "", "");
    else callback(reply.code === 0 ? null : Object.assign(new Error(`${file} exited with ${reply.code}`), { code: reply.code }),
      reply.stdout ?? "", reply.stderr ?? "");
  });
}

/** Whether `folder` is an existing directory, asked without holding main. */
async function isDirectory(folder) {
  return (await fs.promises.stat(folder).catch(() => null))?.isDirectory() === true;
}

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
async function gitOutput(folder, args, { run = execFileOffThread, timeoutMs = 3000 } = {}) {
  if (typeof folder !== "string" || folder.length > 4096 || !path.isAbsolute(folder)) return null;
  if (!await isDirectory(folder)) return null;
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
function gitResult(folder, args, { run = execFileOffThread, timeoutMs = 3000 } = {}) {
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

const samePath = async (left, right) => {
  // Compared where they really are: git names a folder by its long, junction-resolved path, so a
  // project opened by a short (8.3) name or through a junction read as "inside" its own repository.
  const norm = async (value) => {
    const resolved = path.resolve(value);
    const real = await fs.promises.realpath(resolved).catch(() => resolved);
    return path.resolve(real).replace(/[\\/]+$/, "");
  };
  const [a, b] = await Promise.all([norm(left), norm(right)]);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  if (!await isDirectory(local)) return { kind: "missing", root: null, mainRepo: null, branch: null };
  // Git on a busy hard disk took 5-9 s here at app start; the short default timed out and a real
  // repository read as "not git". Only git saying so means "none"; any other failure is unknown (null).
  const result = await gitResult(local, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
    { timeoutMs: GIT_INFO_TIMEOUT_MS, ...options });
  if (!result.ok) return /not a git repository/i.test(result.stderr) ? { kind: "none", root: null, mainRepo: null, branch: null } : null;
  const [root, gitDir, commonDir, head] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!root || !gitDir || !commonDir) return null;
  const branch = head && head !== "HEAD" && /^[\w./-]{1,200}$/.test(head) ? head : null;
  const toNative = (value) => path.resolve(value);
  if (!await samePath(gitDir, commonDir)) {
    // A linked worktree: its git dir is <main>/.git/worktrees/<name>; the main checkout holds <main>/.git.
    const common = toNative(commonDir);
    const mainRepo = path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : common;
    return { kind: "worktree", root: toNative(root), mainRepo, branch };
  }
  return { kind: await samePath(root, local) ? "repo" : "inside", root: toNative(root), mainRepo: null, branch };
}

/** A push is an action, not a quoted mention in a search, prompt or file being inspected. */
function gitPushRequest(command) {
  if (typeof command !== "string") return null;
  const wrappedInput = /^permission · [^\r\n]+? · input (\{[\s\S]*\})$/.exec(command);
  if (wrappedInput) return gitPushRequest(wrappedInput[1]);
  if (command.trimStart().startsWith("{")) {
    try { const input = JSON.parse(command); return gitPushRequest(input.command ?? input.cmd); } catch { return null; }
  }
  const segments = [[]];
  let word = "", quote = null;
  const endWord = () => { if (word) { segments.at(-1).push(word); word = ""; } };
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && command[at + 1] === quote) word += command[++at];
      else word += char;
    } else if (char === "\"" || char === "'") quote = char;
    else if (/[;|&\r\n]/.test(char)) { endWord(); if (segments.at(-1).length) segments.push([]); }
    else if (/\s/.test(char)) endWord();
    else word += char;
  }
  endWord();
  const requests = [];
  for (const words of segments.filter(part => part.length)) {
    const shellFlag = /(?:^|[\\/])(?:bash|sh)(?:\.exe)?$/i.test(words[0]) ? /^-(?:c|lc)$/i
      : /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(words[0]) ? /^-(?:Command|c)$/i
        : /(?:^|[\\/])cmd(?:\.exe)?$/i.test(words[0]) ? /^\/c$/i : null;
    if (shellFlag) {
      const at = words.findIndex((value, index) => index > 0 && shellFlag.test(value));
      const nested = at > 0 ? gitPushRequest(words.slice(at + 1).join(" ")) : null;
      // A shell can change repository context; it cannot borrow the outer command's Git facts.
      if (nested) requests.push(nested.status === "blocked" ? nested
        : { status: "unknown", reason: "Review publication separately from its shell wrapper" });
      continue;
    }
    if (!/^git(?:\.exe)?$/i.test(words[0])) continue;
    let index = 1, uncertain = Boolean(quote);
    while (words[index]?.startsWith("-")) {
      const option = words[index++];
      if (option === "-c") {
        const value = words[index++];
        if (value !== "credential.helper=" && value !== "credential.helper=!gh auth git-credential") uncertain = true;
      } else if (option === "-C" || option === "--git-dir" || option === "--work-tree") { index++; uncertain = true; }
      else uncertain = true;
    }
    if (words[index++] !== "push") continue;
    const rest = words.slice(index);
    const dangerous = rest.some(value => /^(?:\+|--(?:force(?:-with-lease|-if-includes)?|delete|mirror|all|tags|no-verify)(?:=|$)|-[^-]*[fd])/.test(value));
    const args = rest.filter(value => !["-u", "--set-upstream", "--dry-run", "-n"].includes(value));
    const [remote, ...refs] = args;
    const destinations = refs.map(ref => (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref).replace(/^refs\/heads\//, ""));
    const protectedBranch = destinations.some(ref => /^(?:main|master|HEAD)$/.test(ref) || ref.startsWith("refs/") || !ref);
    if (dangerous || protectedBranch || refs.some(ref => ref.startsWith(":"))) { requests.push({ status: "blocked", reason: "Destructive, broad or protected-branch publication requires a person" }); continue; }
    const validRef = ref => /^(?:HEAD|[\w./-]+)(?::(?:refs\/heads\/)?[\w./-]+)?$/.test(ref) && !ref.includes("..") && !ref.includes("@{");
    if (uncertain || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(remote ?? "") || !refs.length || !refs.every(validRef) || args.some(value => value.startsWith("-"))) {
      requests.push({ status: "unknown", reason: "The publication command's destination or options need checking" }); continue;
    }
    requests.push({ status: "review", remote, refs, destinations });
  }
  if (!requests.length) return null;
  if (requests.some(request => request.status === "blocked")) return requests.find(request => request.status === "blocked");
  if (segments.filter(part => part.length).length !== 1 || requests.length !== 1) return { status: "unknown", reason: "Review publication separately from other shell commands" };
  return requests[0];
}

/** A destination identity only: no userinfo, token, query, fragment or remote-helper program. */
function reviewRemoteIdentity(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  const scp = /^[\w.-]+@([\w.-]+):([\w./-]+)$/.exec(value);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git\/?$/, "")}`;
  try {
    const url = new URL(value);
    if (!["https:", "ssh:"].includes(url.protocol) || url.search || url.hash || !/^\/[\w./-]+$/.test(url.pathname)) return null;
    return `${url.host.toLowerCase()}${url.pathname.replace(/\.git\/?$/, "")}`;
  } catch { return null; }
}

/** Local, read-only facts for the reviewer; a configured destination is not publication consent. */
async function readReviewRepository(folder, remote = "origin", options) {
  const unknown = { status: "unknown" };
  if (typeof folder !== "string" || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(remote)) return unknown;
  const local = folder.replace(/^\\\\\?\\/, "");
  if (!path.isAbsolute(local) || !await isDirectory(local)) return unknown;
  const output = async args => {
    const result = await gitResult(local, args, options);
    return result.ok ? result.stdout.trim() : null;
  };
  const [where, fetch, push, head] = await Promise.all([
    output(["rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]),
    output(["remote", "get-url", "--all", remote]),
    output(["remote", "get-url", "--push", "--all", remote]),
    output(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]),
  ]);
  if (!where || !fetch || !push) return unknown;
  const [root, branch] = where.split(/\r?\n/);
  if (!root || !branch || /[\x00-\x1f\x7f]/.test(root + branch)) return unknown;
  const identities = text => {
    const urls = text.split(/\r?\n/);
    if (urls.length > 8) return null;
    const values = urls.map(reviewRemoteIdentity);
    return values.every(Boolean) ? [...new Set(values)] : null;
  };
  const fetchDestinations = identities(fetch), pushDestinations = identities(push);
  if (!fetchDestinations || !pushDestinations) return unknown;
  const defaultBranch = head?.startsWith(`refs/remotes/${remote}/`) ? head.slice(`refs/remotes/${remote}/`.length) : null;
  return { status: "observed", root, branch, remote, defaultBranch, fetchDestinations, pushDestinations };
}

module.exports = { readBranch, readGitInfo, readRemote, repoSlug, gitPushRequest, reviewRemoteIdentity, readReviewRepository };
