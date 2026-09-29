"use strict";

const fs = require("node:fs");
const path = require("node:path");

// AO project identity and the existing durable mission IDs are shared by both views.
// No task store, checkout or model process is created by this binding.
function createAoWorkspaceBoard({ listWorkspaces, listProjects, createProject, missionCall,
  realpath = fs.promises.realpath, platform = process.platform,
  isRepositoryRoot = async directory => fs.existsSync(path.join(directory, ".git")),
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
    if (!project && register && await isRepositoryRoot(item.path)) {
      project = await createProject({ path: item.path });
      if (!project || await canonical(project.path) !== root) throw new Error("AO project registration changed the workspace scope");
    }
    return { workspaceId: item.id, projectId: project?.id ?? null };
  }
  async function readWorkspace(workspaceId, runId) {
    const scope = await binding(workspaceId, false);
    const [board, missions] = await Promise.all([
      missionCall("board", { workspaceId: scope.workspaceId }),
      missionCall("runs", { workspaceId: scope.workspaceId, ...(runId ? { runId } : {}) }),
    ]);
    if (!board?.ok || !missions?.ok) throw new Error("AO mission read is unavailable");
    return { ok: true, ...scope, revision: board.revision, tasks: board.tasks, runs: missions.runs };
  }
  return {
    bind(id) {
      if (pending.has(id)) return pending.get(id);
      const operation = binding(id, true).finally(() => pending.delete(id));
      pending.set(id, operation);
      return operation;
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

module.exports = { createAoWorkspaceBoard };
