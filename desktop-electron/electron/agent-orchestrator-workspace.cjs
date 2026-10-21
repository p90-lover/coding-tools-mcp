"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function git(directory, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", directory, ...args], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

/** Like git(), but keeps git's own message when it refuses, for the user to read. */
function gitOutcome(directory, args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", directory, ...args], { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      const message = String(stderr || error?.message || "").split(/\r?\n/).map(line => line.trim()).find(Boolean) || "";
      resolve({ ok: !error, stdout: String(stdout).trim(), message: message.replace(/^(fatal|error):\s*/i, "") });
    });
  });
}

/**
 * AO starts each session from the repository's default branch. A repository with no remote has
 * none, so AO refuses it unless `ao.defaultBranch` is recorded (as AO does for repositories it
 * creates). Record the current branch once; never touch a repository that has a remote.
 */
async function recordLocalDefaultBranch(directory) {
  if ((await git(directory, ["remote"])) !== "") return;
  if (await git(directory, ["config", "--local", "--get", "ao.defaultBranch"])) return;
  const branch = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch || !/^[\w./-]{1,200}$/.test(branch)) return;
  await git(directory, ["config", "--local", "ao.defaultBranch", branch]);
}

const MAX_BRANCHES = 300;

/** The repository's default branch: the one recorded for AO, else the remote's HEAD. */
async function defaultBranchOf(folder) {
  const recorded = await git(folder, ["config", "--local", "--get", "ao.defaultBranch"]);
  if (recorded) return recorded;
  const remote = await git(folder, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return remote ? remote.replace(/^origin\//, "") : null;
}

/**
 * The project's branches for the chat's branch bar: each local branch, the worktree that has it
 * checked out, and which one the project folder and this chat are on. The default branch comes
 * first, then the user's own branches, then AO's ao/* session branches, each newest first.
 * Read-only: nothing is checked out or created.
 */
async function listBranches(folder, chatRoot = null) {
  const root = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (!root) return { git: false, branches: [] };
  const headOf = async (directory) => {
    const branch = await git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch) return branch;
    const commit = await git(directory, ["rev-parse", "--short", "HEAD"]);
    return commit ? `detached at ${commit}` : null;
  };
  // The default branch first: each branch is measured against it (commits ahead and behind).
  const recordedDefault = await defaultBranchOf(folder);
  const exists = async (name) => Boolean(name) && (await git(folder, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) !== null;
  let defaultBranch = null;
  for (const name of [recordedDefault, "main", "master"]) if (await exists(name)) { defaultBranch = name; break; }
  const fields = ["%(refname:short)", "%(committerdate:unix)", "%(upstream:short)", "%(objectname:short)",
    "%(upstream:track,nobracket)", ...(defaultBranch ? [`%(ahead-behind:${defaultBranch})`] : []), "%(subject)"];
  const [refs, worktrees, current, chatBranch, folderChanges, chatChanges] = await Promise.all([
    git(folder, ["for-each-ref", "--sort=-committerdate", `--count=${MAX_BRANCHES}`, `--format=${fields.join("%09")}`, "refs/heads"]),
    git(folder, ["worktree", "list", "--porcelain"]),
    headOf(folder),
    chatRoot ? headOf(chatRoot) : Promise.resolve(null),
    changesIn(folder),
    chatRoot && path.resolve(chatRoot) !== path.resolve(folder) ? changesIn(chatRoot) : Promise.resolve(null),
  ]);
  const checkedOut = new Map();
  let worktree = null;
  for (const line of String(worktrees || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) worktree = line.slice(9);
    else if (line.startsWith("branch refs/heads/") && worktree) checkedOut.set(line.slice(18), worktree);
  }
  const branches = String(refs || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const columns = line.split("\t");
    const [name, time, upstream, commit, track] = columns;
    // The subject is last: it is the one field that may itself contain a tab.
    const [ahead, behind] = defaultBranch ? String(columns[5] ?? "").split(" ").map(Number) : [];
    const subject = columns.slice(defaultBranch ? 6 : 5).join("\t");
    return {
      // updatedAt is the tip commit's date: a branch made from an old commit and never committed
      // to carries that commit's age, so the list says "last commit", and "same as main" for it.
      name, updatedAt: Number(time) > 0 ? new Date(Number(time) * 1000).toISOString() : null,
      upstream: upstream || null, worktree: checkedOut.get(name) ?? null,
      current: name === current, chat: Boolean(chatBranch) && name === chatBranch,
      commit: commit || null, subject: subject ? subject.slice(0, 200) : null,
      ...(Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead, behind } : {}),
      ...(track ? { track: track.slice(0, 80) } : {}),
    };
  });
  const rank = (branch) => (branch.name === defaultBranch ? 0 : branch.name.startsWith("ao/") ? 2 : 1);
  branches.sort((a, b) => rank(a) - rank(b));
  for (const branch of branches) branch.default = branch.name === defaultBranch;
  return { git: true, root, current, chatBranch, defaultBranch, branches, truncated: branches.length >= MAX_BRANCHES,
    ...(folderChanges ? { folderChanges } : {}), ...(chatChanges ? { chatChanges } : {}) };
}

/** Uncommitted work in a checkout: staged, modified and untracked files. Null when unreadable. */
async function changesIn(directory) {
  // Not git(): its trim() would eat the first line's leading status column (" M file").
  const status = await new Promise((resolve) => {
    execFile("git", ["-C", directory, "status", "--porcelain=v1"], { windowsHide: true, timeout: 10_000 },
      (error, stdout) => resolve(error ? null : String(stdout)));
  });
  if (status === null) return null;
  const counts = { staged: 0, modified: 0, untracked: 0 };
  for (const line of status.split(/\r?\n/)) {
    if (line.length < 3) continue;
    if (line.startsWith("??")) { counts.untracked += 1; continue; }
    if (line[0] !== " ") counts.staged += 1;
    if (line[1] !== " ") counts.modified += 1;
  }
  return counts;
}

/**
 * Checks out an existing local branch in the project folder, where chats work. Refuses uncommitted
 * changes (they would follow the switch or block it halfway) and passes on git's own reason for
 * anything else, such as a branch another worktree has checked out. Nothing is created.
 */
async function switchFolderBranch(folder, branch) {
  if (typeof branch !== "string" || !/^[\w./-]{1,200}$/.test(branch) || branch.startsWith("-")) {
    throw new Error("Choose a branch from the list");
  }
  if (!(await git(folder, ["rev-parse", "--show-toplevel"]))) throw new Error("This project is not a git repository");
  if ((await git(folder, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) === null) {
    throw new Error(`There is no local branch named ${branch}`);
  }
  if ((await git(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"])) === branch) return { switched: false };
  const changes = await git(folder, ["status", "--porcelain", "--untracked-files=no"]);
  if (changes === null) throw new Error("Could not read the project folder's git status");
  if (changes) throw new Error("The project folder has uncommitted changes; commit or stash them before switching branch");
  const outcome = await gitOutcome(folder, ["switch", "--no-guess", branch]);
  if (!outcome.ok) throw new Error(outcome.message || `git could not switch to ${branch}`);
  return { switched: true };
}

// The dependency-link sync asks AO for the project, and on a busy machine that request ran into
// its 30 s timeout: every launch waited for it before AO was even asked for a session. A launch
// now waits a few seconds at most; the sync then finishes on its own (one per project at a time),
// and as the links rarely change between launches, the next launch has its result.
const SYNC_BUDGET_MS = 3_000;
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    Promise.resolve(promise).catch(() => undefined).finally(() => { clearTimeout(timer); resolve(); });
  });
}

// AO project identity and the existing durable mission IDs are shared by both views.
// No task store, checkout or model process is created by this binding.
function createAoWorkspaceBoard({ listWorkspaces, listProjects, createProject, missionCall, readAccounting,
  realpath = fs.promises.realpath, platform = process.platform,
  isRepositoryRoot = async directory => fs.existsSync(path.join(directory, ".git")),
  recordDefaultBranch = recordLocalDefaultBranch,
  // Before AO starts a session, brings the project's links to installed dependencies up to date.
  syncProject = null,
  // Before AO starts a session, gives a project that never chose where its chats work the app's
  // default. Awaited in full: AO must not make a worktree for the first chat first.
  defaultWorkspaceMode = null,
  syncBudgetMs = SYNC_BUDGET_MS,
}) {
  const pending = new Map();
  // branches(): each folder's last list (and the one being read), kept BRANCHES_TTL_MS.
  const branchReads = new Map();
  const BRANCHES_TTL_MS = 5_000;
  async function canonical(directory) {
    if (typeof directory !== "string" || !(platform === "win32" ? path.win32 : path).isAbsolute(directory)) throw new Error("Workspace needs an absolute directory");
    const resolved = await realpath(directory);
    return platform === "win32" ? resolved.replace(/^\\\\\?\\/, "").toLowerCase() : resolved;
  }
  async function matching(items, root) {
    const matches = [];
    for (const item of items) {
      let candidate;
      try { candidate = await canonical(item.path); } catch { continue; }
      if (candidate === root) matches.push(item);
    }
    return matches;
  }
  async function workspace(id) {
    const item = (await listWorkspaces()).find(item => item.id === id);
    if (!item) throw new Error("Workspace is not registered in Coding Tools");
    return { item, root: await canonical(item.path) };
  }
  async function binding(id, register) {
    const { item, root } = await workspace(id);
    const projects = await matching(await listProjects(), root);
    if (projects.length > 1) throw new Error("Workspace matches multiple AO projects; select one explicitly in AO first");
    let project = projects[0];
    // A workspace created from a canonicalized folder is saved as "\\?\C:\...": AO and git need
    // the plain drive path, so it is never handed the long-path prefix.
    const folder = platform === "win32" ? item.path.replace(/^\\\\\?\\/, "") : item.path;
    // Before AO starts a session in a local-only repository, give it a default branch.
    if (register && await isRepositoryRoot(folder)) await recordDefaultBranch(folder);
    if (!project && register && await isRepositoryRoot(folder)) {
      project = await createProject({ path: folder });
      if (!project || await canonical(project.path) !== root) throw new Error("AO project registration changed the workspace scope");
    }
    if (register && project?.id && typeof defaultWorkspaceMode === "function") {
      try { await defaultWorkspaceMode(project); } catch { /* AO's own default, a worktree per chat, still works */ }
    }
    if (register && project?.id && typeof syncProject === "function") await within(syncProject(project, folder), syncBudgetMs);
    return { workspaceId: item.id, projectId: project?.id ?? null };
  }
  async function readWorkspace(workspaceId, runId) {
    const scope = await binding(workspaceId, false);
    const [board, missions] = await Promise.all([
      missionCall("board", { workspaceId: scope.workspaceId }),
      missionCall("runs", { workspaceId: scope.workspaceId, ...(runId ? { runId } : {}) }),
    ]);
    if (!board?.ok || !missions?.ok) throw new Error("AO mission read is unavailable");
    let accounting = {};
    if (typeof readAccounting === "function") {
      try { accounting = await readAccounting({ ...scope, runs: missions.runs }); }
      catch { /* Price/counter failures must not hide the saved mission board. */ }
    }
    return { ok: true, ...scope, revision: board.revision, tasks: board.tasks, runs: missions.runs,
      taskLifecycle: missions.task_lifecycle || [], accounting };
  }
  return {
    bind(id) {
      if (pending.has(id)) return pending.get(id);
      const operation = binding(id, true).finally(() => pending.delete(id));
      pending.set(id, operation);
      return operation;
    },
    /** The workspace's AO project ({ workspaceId, projectId|null }) without registering one or syncing it. */
    project: id => binding(id, false),
    /**
     * The workspace folder's branches, and the one a chat's own folder (`chatRoot`) is on. One list
     * costs about a dozen git processes, and starting each one holds the main process for 100-400 ms
     * on a busy machine: opening a project mounted two branch bars at once, each of which re-reads
     * every 15 s. Callers asking together share one read, and a read is kept for a few seconds.
     */
    async branches(id, chatRoot = null) {
      const { item } = await workspace(id);
      const folder = platform === "win32" ? item.path.replace(/^\\\\\?\\/, "") : item.path;
      const key = `${path.resolve(folder)}\u0000${chatRoot ? path.resolve(chatRoot) : ""}`;
      const cached = branchReads.get(key);
      if (cached && (cached.pending || Date.now() - cached.at < BRANCHES_TTL_MS)) return cached.read;
      const entry = { at: Date.now(), pending: true, read: null };
      entry.read = listBranches(folder, chatRoot).finally(() => { entry.pending = false; entry.at = Date.now(); });
      entry.read.catch(() => branchReads.delete(key));
      branchReads.set(key, entry);
      if (branchReads.size > 64) branchReads.delete(branchReads.keys().next().value);
      return entry.read;
    },
    /** Checks out `branch` in the workspace folder, then lists the branches again. */
    async switchBranch(id, branch) {
      const { item } = await workspace(id);
      const folder = platform === "win32" ? item.path.replace(/^\\\\\?\\/, "") : item.path;
      const { switched } = await switchFolderBranch(folder, branch);
      // Every kept read of this folder is out of date now.
      for (const key of [...branchReads.keys()]) if (key.startsWith(`${path.resolve(folder)}\u0000`)) branchReads.delete(key);
      return { switched, ...await listBranches(folder) };
    },
    readWorkspace,
    async read(projectId, runId) {
      const project = (await listProjects()).find(item => item.id === projectId);
      if (!project) throw new Error("AO project was not found");
      const workspaces = await matching(await listWorkspaces(), await canonical(project.path));
      if (workspaces.length !== 1) throw new Error("AO project needs exactly one registered Coding Tools workspace");
      return readWorkspace(workspaces[0].id, runId);
    },
  };
}

module.exports = { createAoWorkspaceBoard, listBranches, switchFolderBranch, recordLocalDefaultBranch };
