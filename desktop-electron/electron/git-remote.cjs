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

/** The origin remote of an existing local folder as "owner/repo", or null (no git, no origin). */
function readRemote(folder, { run = execFile, timeoutMs = 3000 } = {}) {
  if (typeof folder !== "string" || folder.length > 4096 || !path.isAbsolute(folder)) return Promise.resolve(null);
  if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) return Promise.resolve(null);
  return new Promise((resolve) => {
    run("git", ["-C", folder, "remote", "get-url", "origin"], { windowsHide: true, timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : repoSlug(String(stdout)));
    });
  });
}

module.exports = { readRemote, repoSlug };
