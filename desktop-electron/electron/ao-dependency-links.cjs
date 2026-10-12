"use strict";

// AO runs each chat agent in its own git worktree, which has none of the project's git-ignored
// dependency folders, so the agent asks to reinstall them. AO can link folders from the project
// into every new worktree (the project config's `symlinks`; a junction per folder on Windows).
// This keeps that list filled with the dependency folders the project actually has installed.
//
// Sharing is not free: an install run in a worktree (npm install, npm ci, pip install) changes
// the project's own node_modules or .venv. AO only links a folder while its manifests and
// lockfiles match the project's (a branch that changes them gets its own install).

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

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

const linkKey = value => String(value).trim().replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * The project's next `symlinks` list. Entries the user set are kept as they are; entries this
 * app added earlier (`managed`) are dropped once their folder is gone (or the feature is off);
 * detected folders are added. Returns the list and the entries the app now manages.
 */
function mergeSymlinks(current, detected, managed) {
  const ours = new Set(managed.map(linkKey));
  const wanted = new Set(detected.map(linkKey));
  const userSet = new Set(current.map(linkKey).filter(key => !ours.has(key)));
  const kept = current.filter(entry => userSet.has(linkKey(entry)) || wanted.has(linkKey(entry)));
  const present = new Set(kept.map(linkKey));
  const symlinks = [...kept, ...detected.filter(entry => !present.has(linkKey(entry)))];
  return { symlinks, managed: detected.filter(entry => !userSet.has(linkKey(entry))) };
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Keeps AO projects' `symlinks` in step with their installed dependency folders.
 * `request(method, endpoint, body)` is an AO API call that returns the parsed body or throws.
 * The setting and the entries this app added live in `file`.
 */
function createAoDependencyLinks({ file, request, logger = console }) {
  const synced = new Map();
  const chains = new Map();

  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      const projects = value?.projects && typeof value.projects === "object" ? value.projects : {};
      return {
        enabled: value?.enabled !== false,
        projects: Object.fromEntries(Object.entries(projects)
          .filter(([, entries]) => Array.isArray(entries))
          .map(([id, entries]) => [id, entries.filter(entry => typeof entry === "string")])),
      };
    } catch { return { enabled: true, projects: {} }; }
  }
  function save(state) {
    writePrivateFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { protectDirectory: false });
  }

  async function syncNow(projectId, folder) {
    const state = load();
    const detected = state.enabled ? detectDependencyLinks(folder) : [];
    const managedBefore = state.projects[projectId] || [];
    if (!state.enabled && !managedBefore.length) return { changed: false };
    const key = JSON.stringify([detected, managedBefore]);
    if (synced.get(projectId) === key) return { changed: false };
    const record = await request("GET", `/api/v1/projects/${encodeURIComponent(projectId)}`);
    const project = record?.project;
    // A degraded or scratch project has no config this app should rewrite.
    if (record?.status !== "ok" || !project || project.kind === "scratch") return { changed: false };
    const config = project.config && typeof project.config === "object" ? project.config : {};
    const current = Array.isArray(config.symlinks) ? config.symlinks.filter(entry => typeof entry === "string") : [];
    const next = mergeSymlinks(current, detected, managedBefore);
    const changed = !sameList(next.symlinks, current);
    if (changed) {
      const { symlinks: _previous, ...rest } = config;
      // AO replaces the whole config, so every other setting is sent back as it was.
      await request("PUT", `/api/v1/projects/${encodeURIComponent(projectId)}/config`, {
        config: next.symlinks.length ? { ...rest, symlinks: next.symlinks } : rest,
      });
    }
    if (!sameList(next.managed, managedBefore)) {
      const latest = load();
      if (next.managed.length) latest.projects[projectId] = next.managed; else delete latest.projects[projectId];
      save(latest);
    }
    synced.set(projectId, JSON.stringify([detected, next.managed]));
    return { changed, symlinks: next.symlinks };
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

  return {
    sync,
    enabled: () => load().enabled,
    /** Turning it off removes the app's entries from each project on that project's next sync. */
    setEnabled(enabled) {
      const state = load();
      state.enabled = enabled === true;
      save(state);
      synced.clear();
      return state.enabled;
    },
  };
}

module.exports = { createAoDependencyLinks, detectDependencyLinks, mergeSymlinks };
