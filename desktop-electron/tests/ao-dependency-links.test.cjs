require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAoDependencyLinks, detectDependencyLinks, detectDependencyLinksAsync, mergeManaged } = require("../electron/ao-dependency-links.cjs");
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

test("the sync before each spawn finds the same folders without reading the disk synchronously", async (t) => {
  // Seen live 2026-10-31: one statSync of this scan held every window for 2.3 s on the busy hard disk.
  const root = tree(t, [
    "requirements.txt", ".venv/pyvenv.cfg", "package.json", "node_modules/",
    "frontend/package.json", "frontend/node_modules/react/",
    "backend/pyproject.toml", "backend/venv/pyvenv.cfg",
    "docs/node_modules/", "tools/requirements.txt", "tools/venv/", "api/package.json",
  ]);
  assert.deepEqual(await detectDependencyLinksAsync(root), detectDependencyLinks(root));
  assert.deepEqual(await detectDependencyLinksAsync(path.join(root, "missing")), []);
  const file = path.join(root, "state", "links.json");
  const ao = aoProject({});
  assert.deepEqual((await createAoDependencyLinks({ file, request: ao.request, logger: { warn() {} } }).sync("reg", root)).hardLinkFarms,
    ["node_modules", "frontend/node_modules"]);
  // The next spawn (here in a new app session, so nothing is remembered) scans and reads the
  // state again; saving it, only when the app's own entries change, stays one synchronous step.
  const links = createAoDependencyLinks({ file, request: ao.request, logger: { warn() {} } });
  const { statSync, readFileSync, readdirSync } = fs;
  let blocking = 0;
  Object.assign(fs, {
    statSync: (...args) => { blocking += 1; return statSync(...args); },
    readFileSync: (...args) => { blocking += 1; return readFileSync(...args); },
    readdirSync: (...args) => { blocking += 1; return readdirSync(...args); },
  });
  try {
    assert.deepEqual((await links.sync("reg", root)).hardLinkFarms, ["node_modules", "frontend/node_modules"]);
  } finally {
    Object.assign(fs, { statSync, readFileSync, readdirSync });
  }
  assert.equal(blocking, 0);
});

test("each path list keeps the user's entries and only adds or drops the app's own", () => {
  assert.deepEqual(mergeManaged([".env"], ["frontend/node_modules", ".venv"], []),
    { list: [".env", "frontend/node_modules", ".venv"], managed: ["frontend/node_modules", ".venv"] });
  // A folder that went away is dropped only when the app added it; the user's own entry stays.
  assert.deepEqual(mergeManaged([".env", "node_modules", ".venv"], [], [".venv"]),
    { list: [".env", "node_modules"], managed: [] });
  // An entry the user already had is never claimed (or later removed) by the app.
  assert.deepEqual(mergeManaged(["frontend\\node_modules/"], ["frontend/node_modules"], []),
    { list: ["frontend\\node_modules/"], managed: [] });
  // A folder the user put in the other list is left to that choice.
  assert.deepEqual(mergeManaged([], ["node_modules", "web/node_modules"], [], ["node_modules"]),
    { list: ["web/node_modules"], managed: ["web/node_modules"] });
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

const readState = file => JSON.parse(fs.readFileSync(file, "utf8"));

test("a sync farms node_modules by default, shares a venv only when asked, and sends the whole config back", async (t) => {
  const root = tree(t, ["requirements.txt", ".venv/pyvenv.cfg", "frontend/package.json", "frontend/node_modules/"]);
  const file = path.join(root, "state", "links.json");
  const ao = aoProject({ env: { A: "1" }, symlinks: [".env"], postCreate: ["echo ok"] });
  const links = createAoDependencyLinks({ file, request: ao.request, logger: { warn() {} } });

  assert.deepEqual(links.settings(), { enabled: true, python: false }, "Node packages on, Python environment off by default");
  assert.deepEqual(await links.sync("reg", root), { changed: true, symlinks: [".env"], hardLinkFarms: ["frontend/node_modules"] });
  assert.deepEqual(ao.requests, [
    ["GET", "/api/v1/projects/reg", undefined],
    ["PUT", "/api/v1/projects/reg/config", { config: { env: { A: "1" }, postCreate: ["echo ok"], symlinks: [".env"], hardLinkFarms: ["frontend/node_modules"] } }],
  ]);
  assert.deepEqual(readState(file), { enabled: true, python: false, projects: {}, farms: { reg: ["frontend/node_modules"] } });

  // Nothing changed on disk: the next spawn costs a few stats and no AO request.
  assert.deepEqual(await links.sync("reg", root), { changed: false });
  assert.equal(ao.requests.length, 2);

  // Sharing the Python environment links the venv; the farm stays.
  assert.deepEqual(links.set({ python: true }), { enabled: true, python: true });
  await links.sync("reg", root);
  assert.deepEqual(ao.requests.at(-1), ["PUT", "/api/v1/projects/reg/config",
    { config: { env: { A: "1" }, postCreate: ["echo ok"], symlinks: [".env", ".venv"], hardLinkFarms: ["frontend/node_modules"] } }]);
  assert.deepEqual(readState(file), { enabled: true, python: true, projects: { reg: [".venv"] }, farms: { reg: ["frontend/node_modules"] } });

  // Both off: the app's entries leave the project; the user's .env stays.
  assert.deepEqual(links.set({ enabled: false, python: false }), { enabled: false, python: false });
  await links.sync("reg", root);
  assert.deepEqual(ao.requests.at(-1), ["PUT", "/api/v1/projects/reg/config", { config: { env: { A: "1" }, postCreate: ["echo ok"], symlinks: [".env"] } }]);
  assert.deepEqual(readState(file), { enabled: false, python: false, projects: {}, farms: {} });
  const count = ao.requests.length;
  await links.sync("reg", root);
  assert.equal(ao.requests.length, count, "off and nothing left to remove: no AO request");
});

test("node_modules the app shared before moves to a farm; the user's own entries stay where they are", async (t) => {
  const root = tree(t, ["package.json", "node_modules/", "web/package.json", "web/node_modules/", "requirements.txt", ".venv/pyvenv.cfg"]);
  const file = path.join(root, "links.json");
  // What the previous version left: node_modules and .venv shared by the app.
  fs.writeFileSync(file, JSON.stringify({ enabled: true, projects: { reg: ["node_modules", ".venv"] } }));
  const ao = aoProject({ symlinks: [".env", "node_modules", ".venv"] });
  const links = createAoDependencyLinks({ file, request: ao.request, logger: { warn() {} } });
  await links.sync("reg", root);
  assert.deepEqual(ao.stored(), { symlinks: [".env"], hardLinkFarms: ["node_modules", "web/node_modules"] });
  assert.deepEqual(readState(file), { enabled: true, python: false, projects: {}, farms: { reg: ["node_modules", "web/node_modules"] } });

  // The user shares web/node_modules on purpose and farms .venv: the app adds neither elsewhere.
  const own = aoProject({ symlinks: ["web\\node_modules"], hardLinkFarms: [".venv"] });
  const mine = createAoDependencyLinks({ file: path.join(root, "own.json"), request: own.request, logger: { warn() {} } });
  mine.set({ python: true });
  await mine.sync("reg", root);
  assert.deepEqual(own.stored(), { symlinks: ["web\\node_modules"], hardLinkFarms: [".venv", "node_modules"] });
});

test("a project with no config gets one holding only the farm, and a failed AO call never throws", async (t) => {
  const root = tree(t, ["package.json", "node_modules/"]);
  const ao = aoProject(undefined);
  const links = createAoDependencyLinks({ file: path.join(root, "links.json"), request: ao.request, logger: { warn() {} } });
  await links.sync("reg", root);
  assert.deepEqual(ao.stored(), { hardLinkFarms: ["node_modules"] });

  const warnings = [];
  const failing = createAoDependencyLinks({ file: path.join(root, "other.json"), logger: { warn: message => warnings.push(message) },
    request: async () => { throw new Error("AO is not running"); } });
  assert.deepEqual(await failing.sync("reg", root), { changed: false });
  assert.match(warnings[0], /AO is not running/);
});

test("the links in effect are repo-relative POSIX paths, a farmed path listed only as farmed", async (t) => {
  const root = tree(t, []);
  const ao = aoProject({ symlinks: ["frontend\\node_modules/", ".venv", ".env", ".venv"], hardLinkFarms: ["frontend/node_modules", "node_modules"] });
  const links = createAoDependencyLinks({ file: path.join(root, "links.json"), request: ao.request, logger: { warn() {} } });
  assert.deepEqual(await links.inEffect("reg"), { shared: [".venv", ".env"], farmed: ["frontend/node_modules", "node_modules"] });
  assert.deepEqual(ao.requests, [["GET", "/api/v1/projects/reg", undefined]], "read-only");
  assert.deepEqual(await createAoDependencyLinks({ file: path.join(root, "x.json"), request: aoProject(undefined).request }).inEffect("reg"), { shared: [], farmed: [] });
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
  // The approval card's lookup only reads the binding.
  assert.deepEqual(await bridge.project("ws"), { workspaceId: "ws", projectId: "reg" });
  assert.deepEqual(synced, []);
  assert.deepEqual(await bridge.bind("ws"), { workspaceId: "ws", projectId: "reg" });
  assert.deepEqual(synced, [["reg", "C:\\work\\reg"]]);
});

test("a slow link sync delays a session's launch only by its budget, then finishes on its own", async () => {
  let finish;
  let finished = false;
  const bridge = createAoWorkspaceBoard({
    platform: "win32", realpath: async value => value, isRepositoryRoot: async () => true, recordDefaultBranch: async () => {},
    listWorkspaces: async () => [{ id: "ws", path: "C:\\work\\reg" }],
    listProjects: async () => [{ id: "reg", path: "C:\\work\\reg" }],
    createProject: async () => { throw new Error("already registered"); },
    missionCall: async () => ({ ok: true, revision: 1, tasks: [], runs: [] }),
    // AO answering the project read only after its 30 s timeout, as it did on a busy machine.
    syncProject: () => new Promise(resolve => { finish = () => { finished = true; resolve(); }; }),
    syncBudgetMs: 20,
  });
  const started = Date.now();
  assert.deepEqual(await bridge.bind("ws"), { workspaceId: "ws", projectId: "reg" });
  assert.ok(Date.now() - started < 1_000, "the launch went on after the budget");
  assert.equal(finished, false, "the sync is still running");
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, true);
  // A sync that fails is the sync's own business; the launch is not failed by it.
  const failing = createAoWorkspaceBoard({
    platform: "win32", realpath: async value => value, isRepositoryRoot: async () => true, recordDefaultBranch: async () => {},
    listWorkspaces: async () => [{ id: "ws", path: "C:\\work\\reg" }],
    listProjects: async () => [{ id: "reg", path: "C:\\work\\reg" }],
    createProject: async () => { throw new Error("already registered"); },
    missionCall: async () => ({ ok: true, revision: 1, tasks: [], runs: [] }),
    syncProject: async () => { throw new Error("AO is busy"); },
  });
  assert.deepEqual(await failing.bind("ws"), { workspaceId: "ws", projectId: "reg" });
});

test("another whole-config write waits for a running sync and runs before the next one", async () => {
  const { createAoDependencyLinks } = require("../electron/ao-dependency-links.cjs");
  const fsMod = require("node:fs"), osMod = require("node:os"), pathMod = require("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "ao-links-exclusive-"));
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const links = createAoDependencyLinks({ file: pathMod.join(dir, "links.json"), request: async () => { order.push("sync-read"); await gate; return { status: "ok", project: { kind: "scratch" } }; }, logger: { warn() {} } });
  fsMod.mkdirSync(pathMod.join(dir, "proj", "node_modules"), { recursive: true });
  fsMod.writeFileSync(pathMod.join(dir, "proj", "package.json"), "{}");
  const syncing = links.sync("p1", pathMod.join(dir, "proj"));
  const exclusive = links.exclusive("p1", async () => { order.push("mode-write"); return "done"; });
  // The sync reads the disk without blocking before it asks AO.
  for (let tries = 0; tries < 200 && !order.length; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["sync-read"], "the mode write waits for the running sync");
  release();
  assert.equal(await exclusive, "done");
  await syncing;
  assert.deepEqual(order, ["sync-read", "mode-write"]);
  await assert.rejects(links.exclusive("p1", async () => { throw new Error("nope"); }), /nope/, "its errors reach the caller");
  assert.equal(await links.exclusive("p1", async () => "after"), "after", "a failure does not wedge the queue");
});
