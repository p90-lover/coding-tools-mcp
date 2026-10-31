"use strict";

// AO runs each chat agent in its own git worktree, which has none of the project's git-ignored
// dependency folders, so the agent asks to reinstall them. This keeps the AO project config filled
// with the dependency folders the project actually has installed:
//
// - node_modules -> `hardLinkFarms` ("Reuse installed Node packages", on by default). AO rebuilds
//   the folder in each worktree as real directories whose files are hard links to the project's,
//   so an agent's `npm ci` or `npm install` replaces only the worktree's links, never the
//   project's packages. Same drive only; a file written in place (not replaced) is still shared.
// - .venv / venv -> `symlinks` ("Share the Python environment", off by default). AO links the
//   project's environment itself (a junction on Windows): a `pip install` in a worktree changes
//   the project's environment, whose launchers point at the project's python.
//
// AO builds either only while the folder's manifests and lockfiles match the project's (a branch
// that changes them gets its own install).

const fs = require("node:fs");
const path = require("node:path");

const NODE_FOLDER = "node_modules";
const PYTHON_FOLDERS = [".venv", "venv"];
const PYTHON_MANIFESTS = ["requirements.txt", "pyproject.toml"];
/** Upper bound on the first-level folders looked at, so a huge project root stays a quick scan. */
const MAX_SUBFOLDERS = 200;

function statOf(fsImpl, file) {
  try { return fsImpl.statSync(file, { throwIfNoEntry: false }) || null; } catch { return null; }
}
const isFile = (fsImpl, file) => statOf(fsImpl, file)?.isFile() === true;
const isDir = (fsImpl, file) => statOf(fsImpl, file)?.isDirectory() === true;

/** A Python virtual environment, not just a folder that happens to be called venv. */
function venvIn(fsImpl, folder) {
  return PYTHON_FOLDERS.filter(name => isFile(fsImpl, path.join(folder, name, "pyvenv.cfg")));
}

/**
 * The dependency folders installed in a project, as repo-relative paths with "/":
 * node_modules at the root and in first-level folders that have a package.json, and a
 * .venv/venv at the root or in a first-level folder that has requirements.txt or pyproject.toml.
 * Only stats a handful of paths, so it runs before every spawn.
 */
function detectDependencyLinks(root, { fs: fsImpl = fs } = {}) {
  const found = [];
  if (isFile(fsImpl, path.join(root, "package.json")) && isDir(fsImpl, path.join(root, NODE_FOLDER))) found.push(NODE_FOLDER);
  found.push(...venvIn(fsImpl, root));
  let entries = [];
  try { entries = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  const folders = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== NODE_FOLDER && !PYTHON_FOLDERS.includes(entry.name))
    .map(entry => entry.name).sort().slice(0, MAX_SUBFOLDERS);
  for (const name of folders) {
    const folder = path.join(root, name);
    if (isFile(fsImpl, path.join(folder, "package.json")) && isDir(fsImpl, path.join(folder, NODE_FOLDER))) found.push(`${name}/${NODE_FOLDER}`);
    if (PYTHON_MANIFESTS.some(file => isFile(fsImpl, path.join(folder, file)))) found.push(...venvIn(fsImpl, folder).map(venv => `${name}/${venv}`));
  }
  return found;
}

/**
 * detectDependencyLinks without blocking, for the sync before each spawn: up to a few hundred
 * stats on the main process, and one of them held every window for 2.3 s on the app's busy hard
 * disk (2026-10-31). The same list, in the same order.
 */
async function detectDependencyLinksAsync(root, { fs: fsImpl = fs } = {}) {
  const statAsync = file => fsImpl.promises.stat(file).catch(() => null);
  const isFileAsync = async file => (await statAsync(file))?.isFile() === true;
  const isDirAsync = async file => (await statAsync(file))?.isDirectory() === true;
  const venvsIn = async folder => {
    const present = await Promise.all(PYTHON_FOLDERS.map(name => isFileAsync(path.join(folder, name, "pyvenv.cfg"))));
    return PYTHON_FOLDERS.filter((_, index) => present[index]);
  };
  const nodeIn = async folder => (await isFileAsync(path.join(folder, "package.json"))) && isDirAsync(path.join(folder, NODE_FOLDER));
  const [rootNode, rootVenvs, entries] = await Promise.all([
    nodeIn(root), venvsIn(root), fsImpl.promises.readdir(root, { withFileTypes: true }).catch(() => null),
  ]);
  const found = [...(rootNode ? [NODE_FOLDER] : []), ...rootVenvs];
  if (!entries) return found;
  const folders = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== NODE_FOLDER && !PYTHON_FOLDERS.includes(entry.name))
    .map(entry => entry.name).sort().slice(0, MAX_SUBFOLDERS);
  const perFolder = await Promise.all(folders.map(async name => {
    const folder = path.join(root, name);
    const [node, python] = await Promise.all([
      nodeIn(folder),
      Promise.all(PYTHON_MANIFESTS.map(file => isFileAsync(path.join(folder, file)))).then(hits => hits.some(Boolean)),
    ]);
    return [...(node ? [`${name}/${NODE_FOLDER}`] : []), ...(python ? (await venvsIn(folder)).map(venv => `${name}/${venv}`) : [])];
  }));
  return [...found, ...perFolder.flat()];
}

const linkKey = value => String(value).trim().replace(/\\/g, "/").replace(/\/+$/, "");
const isNodeFolder = entry => linkKey(entry).split("/").pop() === NODE_FOLDER;
const strings = value => Array.isArray(value) ? value.filter(entry => typeof entry === "string") : [];

/**
 * One of the project's next path lists (`symlinks` or `hardLinkFarms`). Entries the user set are
 * kept as they are; entries this app added earlier (`managed`) are dropped once their folder is
 * gone (or the setting is off); detected folders are added, except those the user put in the
 * other list (`reserved`), whose choice stands. Returns the list and the entries the app now manages.
 */
function mergeManaged(current, detected, managed, reserved = []) {
  const ours = new Set(managed.map(linkKey));
  const userOther = new Set(reserved.map(linkKey));
  const wanted = new Set(detected.map(linkKey).filter(key => !userOther.has(key)));
  const userSet = new Set(current.map(linkKey).filter(key => !ours.has(key)));
  const kept = current.filter(entry => userSet.has(linkKey(entry)) || wanted.has(linkKey(entry)));
  const present = new Set(kept.map(linkKey));
  const list = [...kept, ...detected.filter(entry => wanted.has(linkKey(entry)) && !present.has(linkKey(entry)))];
  return { list, managed: detected.filter(entry => wanted.has(linkKey(entry)) && !userSet.has(linkKey(entry))) };
}

/** The entries of `current` the app did not add (`managed`): the user's own. */
const userEntries = (current, managed) => {
  const ours = new Set(managed.map(linkKey));
  return current.filter(entry => !ours.has(linkKey(entry)));
};

/** A path list as repo-relative POSIX paths, without duplicates. */
const posixPaths = entries => [...new Set(entries.map(linkKey).filter(Boolean))];

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Keeps AO projects' `hardLinkFarms` and `symlinks` in step with their installed dependency
 * folders. `request(method, endpoint, body)` is an AO API call that returns the parsed body or
 * throws. The settings and the entries this app added live in `file`: `enabled` (reuse Node
 * packages, default on), `python` (share the Python environment, default off), and per project
 * the app's own `projects` (symlinks) and `farms` (hardLinkFarms) entries.
 */
function createAoDependencyLinks({ file, request, logger = console }) {
  const synced = new Map();
  const chains = new Map();

  const lists = value => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
    .filter(([, entries]) => Array.isArray(entries))
    .map(([id, entries]) => [id, strings(entries)]));
  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return { enabled: value?.enabled !== false, python: value?.python === true, projects: lists(value?.projects), farms: lists(value?.farms) };
    } catch { return { enabled: true, python: false, projects: {}, farms: {} }; }
  }
  /** load for the sync before each spawn, without a synchronous read. */
  async function loadAsync() {
    try {
      const value = JSON.parse(await fs.promises.readFile(file, "utf8"));
      return { enabled: value?.enabled !== false, python: value?.python === true, projects: lists(value?.projects), farms: lists(value?.farms) };
    } catch { return { enabled: true, python: false, projects: {}, farms: {} }; }
  }
  // A backend-bundle module may only require Node built-ins and other bundle modules, so the
  // small atomic write is done here: a temp file next to the state, then a rename over it.
  function save(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async function syncNow(projectId, folder) {
    const state = await loadAsync();
    const detected = state.enabled || state.python ? await detectDependencyLinksAsync(folder) : [];
    const farmsWanted = state.enabled ? detected.filter(isNodeFolder) : [];
    // node_modules is never shared any more: an app entry for it in `symlinks` (an earlier
    // version put it there) is dropped below and the folder farmed instead.
    const linksWanted = state.python ? detected.filter(entry => !isNodeFolder(entry)) : [];
    const linksBefore = state.projects[projectId] || [];
    const farmsBefore = state.farms[projectId] || [];
    if (!farmsWanted.length && !linksWanted.length && !linksBefore.length && !farmsBefore.length) return { changed: false };
    const key = JSON.stringify([farmsWanted, linksWanted, linksBefore, farmsBefore]);
    if (synced.get(projectId) === key) return { changed: false };
    const record = await request("GET", `/api/v1/projects/${encodeURIComponent(projectId)}`);
    const project = record?.project;
    // A degraded or scratch project has no config this app should rewrite.
    if (record?.status !== "ok" || !project || project.kind === "scratch") return { changed: false };
    const config = project.config && typeof project.config === "object" ? project.config : {};
    const currentLinks = strings(config.symlinks);
    const currentFarms = strings(config.hardLinkFarms);
    // A folder the user listed in one list themselves is not added to the other.
    const links = mergeManaged(currentLinks, linksWanted, linksBefore, userEntries(currentFarms, farmsBefore));
    const farms = mergeManaged(currentFarms, farmsWanted, farmsBefore, userEntries(currentLinks, linksBefore));
    const changed = !sameList(links.list, currentLinks) || !sameList(farms.list, currentFarms);
    if (changed) {
      const { symlinks: _links, hardLinkFarms: _farms, ...rest } = config;
      // AO replaces the whole config, so every other setting is sent back as it was.
      await request("PUT", `/api/v1/projects/${encodeURIComponent(projectId)}/config`, {
        config: { ...rest, ...(links.list.length ? { symlinks: links.list } : {}), ...(farms.list.length ? { hardLinkFarms: farms.list } : {}) },
      });
    }
    if (!sameList(links.managed, linksBefore) || !sameList(farms.managed, farmsBefore)) {
      const latest = load();
      if (links.managed.length) latest.projects[projectId] = links.managed; else delete latest.projects[projectId];
      if (farms.managed.length) latest.farms[projectId] = farms.managed; else delete latest.farms[projectId];
      save(latest);
    }
    synced.set(projectId, JSON.stringify([farmsWanted, linksWanted, links.managed, farms.managed]));
    return { changed, symlinks: links.list, hardLinkFarms: farms.list };
  }

  /** Brings one project's links up to date; one sync per project at a time. Never throws. */
  function sync(projectId, folder) {
    if (typeof projectId !== "string" || !projectId || typeof folder !== "string" || !folder) return Promise.resolve({ changed: false });
    const previous = chains.get(projectId) || Promise.resolve();
    const run = previous.then(() => syncNow(projectId, folder)).catch((error) => {
      logger.warn?.(`[ao] dependency links for project ${projectId} were not updated: ${error?.message || error}`);
      return { changed: false };
    });
    chains.set(projectId, run);
    return run;
  }

  /**
   * Runs `work` on the project's sync queue. AO replaces a project's whole config on every PUT,
   * so any other read-modify-write of it (the workspace mode) must not interleave with a sync,
   * or the later PUT drops what the earlier one wrote. Unlike sync, it passes errors back.
   */
  function exclusive(projectId, work) {
    const previous = chains.get(projectId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    chains.set(projectId, run.catch(() => undefined));
    return run;
  }

  const settings = (state = load()) => ({ enabled: state.enabled, python: state.python });
  return {
    sync,
    exclusive,
    /** `enabled`: reuse installed Node packages (hard-link farms); `python`: share the Python environment. */
    settings: () => settings(),
    /**
     * Changes either setting (a boolean each; others are left as they are). Turning one off
     * removes the app's entries for it from each project on that project's next sync.
     */
    set({ enabled, python } = {}) {
      const state = load();
      if (typeof enabled === "boolean") state.enabled = enabled;
      if (typeof python === "boolean") state.python = python;
      save(state);
      synced.clear();
      return settings(state);
    },
    /**
     * The folders a project's new worktrees get from the project, as repo-relative POSIX paths:
     * `shared` (symlinks: the project's own folder or file) and `farmed` (hardLinkFarms). A path
     * in both is farmed (AO builds farms first), so it is only listed there.
     */
    async inEffect(projectId) {
      const record = await request("GET", `/api/v1/projects/${encodeURIComponent(projectId)}`);
      const config = record?.status === "ok" && record.project?.config && typeof record.project.config === "object" ? record.project.config : {};
      const farmed = posixPaths(strings(config.hardLinkFarms));
      const farmedKeys = new Set(farmed);
      return { shared: posixPaths(strings(config.symlinks)).filter(entry => !farmedKeys.has(entry)), farmed };
    },
  };
}

module.exports = { createAoDependencyLinks, detectDependencyLinks, detectDependencyLinksAsync, mergeManaged };
