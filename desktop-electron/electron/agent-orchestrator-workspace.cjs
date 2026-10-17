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

/**
 * The project's branches for the chat's branch bar: each local branch (newest commit first), the
 * worktree that has it checked out, and which one the project folder and this chat are on.
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
  const [refs, worktrees, current, chatBranch] = await Promise.all([
    git(folder, ["for-each-ref", "--sort=-committerdate", `--count=${MAX_BRANCHES}`,
      "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:short)", "refs/heads"]),
    git(folder, ["worktree", "list", "--porcelain"]),
    headOf(folder),
    chatRoot ? headOf(chatRoot) : Promise.resolve(null),
  ]);
  const checkedOut = new Map();
  let worktree = null;
  for (const line of String(worktrees || "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) worktree = line.slice(9);
    else if (line.startsWith("branch refs/heads/") && worktree) checkedOut.set(line.slice(18), worktree);
  }
  const branches = String(refs || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, time, upstream] = line.split("\t");
    return {
      name, updatedAt: Number(time) > 0 ? new Date(Number(time) * 1000).toISOString() : null,
      upstream: upstream || null, worktree: checkedOut.get(name) ?? null,
      current: name === current, chat: Boolean(chatBranch) && name === chatBranch,
    };
  });
  return { git: true, root, current, chatBranch, branches, truncated: branches.length >= MAX_BRANCHES };
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
  syncBudgetMs = SYNC_BUDGET_MS,
}) {
  const pending = new Map();
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
    /** The workspace folder's branches, and the one a chat's own folder (`chatRoot`) is on. */
    async branches(id, chatRoot = null) {
      const { item } = await workspace(id);
      const folder = platform === "win32" ? item.path.replace(/^\\\\\?\\/, "") : item.path;
      return listBranches(folder, chatRoot);
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

module.exports = { createAoWorkspaceBoard, listBranches, recordLocalDefaultBranch };
