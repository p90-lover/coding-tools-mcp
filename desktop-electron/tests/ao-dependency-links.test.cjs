const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAoDependencyLinks, detectDependencyLinks, mergeSymlinks } = require("../electron/ao-dependency-links.cjs");
const { createAoWorkspaceBoard } = require("../electron/agent-orchestrator-workspace.cjs");

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-deps-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of files) {
    const target = path.join(root, entry);
    if (entry.endsWith("/")) fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ""); }
  }
  return root;
}

test("detection finds installed node_modules and virtual environments where a project keeps them", (t) => {
  const root = tree(t, [
    "requirements.txt", ".venv/pyvenv.cfg",
    "frontend/package.json", "frontend/node_modules/react/",
    "backend/pyproject.toml", "backend/venv/pyvenv.cfg",
    // Not dependency folders: no package.json, a folder only named venv, a manifest with nothing installed.
    "docs/node_modules/", "tools/requirements.txt", "tools/venv/",
    "api/package.json",
    ".cache/package.json", ".cache/node_modules/",
  ]);
  assert.deepEqual(detectDependencyLinks(root), [".venv", "backend/venv", "frontend/node_modules"]);

  const node = tree(t, ["package.json", "node_modules/", "venv/pyvenv.cfg"]);
  assert.deepEqual(detectDependencyLinks(node), ["node_modules", "venv"]);
  assert.deepEqual(detectDependencyLinks(path.join(node, "missing")), []);
});

test("the symlinks list keeps the user's entries and only adds or drops the app's own", () => {
  assert.deepEqual(mergeSymlinks([".env"], ["frontend/node_modules", ".venv"], []),
    { symlinks: [".env", "frontend/node_modules", ".venv"], managed: ["frontend/node_modules", ".venv"] });
  // A folder that went away is dropped only when the app added it; the user's own entry stays.
  assert.deepEqual(mergeSymlinks([".env", "node_modules", ".venv"], [], [".venv"]),
    { symlinks: [".env", "node_modules"], managed: [] });
  // An entry the user already had is never claimed (or later removed) by the app.
  assert.deepEqual(mergeSymlinks(["frontend\\node_modules/"], ["frontend/node_modules"], []),
    { symlinks: ["frontend\\node_modules/"], managed: [] });
});

function aoProject(config) {
  const requests = [];
  let stored = config;
  const request = async (method, endpoint, body) => {
    requests.push([method, endpoint, body]);
    if (method === "GET") return { status: "ok", project: { id: "reg", kind: "single_repo", path: "C:\\reg", ...(stored ? { config: stored } : {}) } };
    stored = body.config;
    return { project: { id: "reg" } };
  };
  return { requests, request, stored: () => stored };
}

test("a sync sends AO the whole config back with the detected folders added, once", async (t) => {
  const root = tree(t, ["requirements.txt", ".venv/pyvenv.cfg", "frontend/package.json", "frontend/node_modules/"]);
  const file = path.join(root, "state", "links.json");
  const ao = aoProject({ env: { A: "1" }, symlinks: [".env"], postCreate: ["echo ok"] });
  const links = createAoDependencyLinks({ file, request: ao.request, logger: { warn() {} } });

  assert.equal(links.enabled(), true, "on by default");
  assert.deepEqual(await links.sync("reg", root), { changed: true, symlinks: [".env", ".venv", "frontend/node_modules"] });
  assert.deepEqual(ao.requests, [
    ["GET", "/api/v1/projects/reg", undefined],
    ["PUT", "/api/v1/projects/reg/config", { config: { env: { A: "1" }, postCreate: ["echo ok"], symlinks: [".env", ".venv", "frontend/node_modules"] } }],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { enabled: true, projects: { reg: [".venv", "frontend/node_modules"] } });

  // Nothing changed on disk: the next spawn costs a few stats and no AO request.
  assert.deepEqual(await links.sync("reg", root), { changed: false });
  assert.equal(ao.requests.length, 2);

  // Turned off: the app's entries leave the project; the user's .env stays.
  assert.equal(links.setEnabled(false), false);
  await links.sync("reg", root);
  assert.deepEqual(ao.requests.at(-1), ["PUT", "/api/v1/projects/reg/config", { config: { env: { A: "1" }, postCreate: ["echo ok"], symlinks: [".env"] } }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { enabled: false, projects: {} });
  const count = ao.requests.length;
  await links.sync("reg", root);
  assert.equal(ao.requests.length, count, "off and nothing left to remove: no AO request");
});

test("a project with no config gets one holding only the links, and a failed AO call never throws", async (t) => {
  const root = tree(t, ["package.json", "node_modules/"]);
  const ao = aoProject(undefined);
  const links = createAoDependencyLinks({ file: path.join(root, "links.json"), request: ao.request, logger: { warn() {} } });
  await links.sync("reg", root);
  assert.deepEqual(ao.stored(), { symlinks: ["node_modules"] });

  const warnings = [];
  const failing = createAoDependencyLinks({ file: path.join(root, "other.json"), logger: { warn: message => warnings.push(message) },
    request: async () => { throw new Error("AO is not running"); } });
  assert.deepEqual(await failing.sync("reg", root), { changed: false });
  assert.match(warnings[0], /AO is not running/);
});

test("binding a workspace for a session syncs its project's links; reading the board does not", async () => {
  const synced = [];
  const bridge = createAoWorkspaceBoard({
    platform: "win32", realpath: async value => value, isRepositoryRoot: async () => true, recordDefaultBranch: async () => {},
    listWorkspaces: async () => [{ id: "ws", path: "C:\\work\\reg" }],
    listProjects: async () => [{ id: "reg", path: "C:\\work\\reg" }],
    createProject: async () => { throw new Error("already registered"); },
    missionCall: async () => ({ ok: true, revision: 1, tasks: [], runs: [] }),
    syncProject: async (project, folder) => { synced.push([project.id, folder]); },
  });
  await bridge.readWorkspace("ws");
  assert.deepEqual(synced, []);
  assert.deepEqual(await bridge.bind("ws"), { workspaceId: "ws", projectId: "reg" });
  assert.deepEqual(synced, [["reg", "C:\\work\\reg"]]);
});
