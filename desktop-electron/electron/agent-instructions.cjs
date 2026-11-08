"use strict";
// The person's standing instructions for every chat agent (Settings › Instructions), as Codex's
// custom instructions and its global and project AGENTS.md:
// - a global AGENTS.md, kept with the app's data, that applies in every project;
// - the workspace's own AGENTS.md, the file at the root of the project's folder.
// Agents read project files only when they choose to (Claude Code reads CLAUDE.md, not AGENTS.md),
// so both are put in front of every new agent's first message, and in front of a running agent's
// next message whenever either changed since that agent was given them.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const WORKSPACE_FILE = "AGENTS.md";
/** What Settings saves of either file; more is refused rather than cut. */
const MAX_SAVE_BYTES = 256 * 1024;
/** What of either file goes into a message: a long file is cut, and the agent is told where it is. */
const MAX_PROMPT_BYTES = 24 * 1024;

const utf8Bytes = (text) => Buffer.byteLength(text, "utf8");
function utf8Prefix(text, bytes) {
  if (utf8Bytes(text) <= bytes) return text;
  let cut = Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8");
  // A character split at the cut decodes as U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut;
}

async function readText(file) {
  try {
    return (await fs.promises.readFile(file, "utf8")).replace(/^﻿/, "");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
    throw error;
  }
}

/**
 * `globalFile`: where the global AGENTS.md is kept. `workspaces`: the app's projects ({ id, path }).
 */
function createAgentInstructions({ globalFile, workspaces }) {
  if (typeof globalFile !== "string" || !path.isAbsolute(globalFile)) throw new Error("The global AGENTS.md needs an absolute path");
  async function workspaceFolder(workspaceId) {
    if (typeof workspaceId !== "string" || !workspaceId || typeof workspaces !== "function") return null;
    const item = (await workspaces()).find((candidate) => candidate?.id === workspaceId);
    const folder = typeof item?.path === "string" ? item.path.replace(/^\\\\\?\\/, "") : "";
    return folder && path.isAbsolute(folder) ? folder : null;
  }
  /** Both files as Settings shows them; `workspace` is null when the project has no folder. */
  async function read(workspaceId = null) {
    const folder = await workspaceFolder(workspaceId);
    const workspaceFile = folder ? path.join(folder, WORKSPACE_FILE) : null;
    const [global, workspace] = await Promise.all([readText(globalFile), workspaceFile ? readText(workspaceFile) : null]);
    return { global, globalFile, workspace, workspaceFile };
  }
  /** The projects Settings offers for a workspace AGENTS.md: those with a folder. */
  async function projects() {
    if (typeof workspaces !== "function") return [];
    return (await workspaces()).flatMap((item) => {
      const folder = typeof item?.path === "string" ? item.path.replace(/^\\\\\?\\/, "") : "";
      if (typeof item?.id !== "string" || !item.id || !folder || !path.isAbsolute(folder)) return [];
      const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : path.basename(folder);
      return [{ id: item.id, name, path: folder }];
    });
  }
  /** Saves one file (`scope`: "global" or "workspace"); empty text leaves an empty file. */
  async function save({ scope, workspaceId = null, text } = {}) {
    if (typeof text !== "string") throw new Error("Write the instructions as text");
    if (utf8Bytes(text) > MAX_SAVE_BYTES) throw new Error(`Keep AGENTS.md under ${MAX_SAVE_BYTES / 1024} KB`);
    const content = text.replace(/\r\n/g, "\n");
    if (scope === "global") {
      await writePrivateFileAtomicAsync(globalFile, content, { durable: true });
    } else if (scope === "workspace") {
      const folder = await workspaceFolder(workspaceId);
      if (!folder) throw new Error("Choose a project with a folder");
      // The project's own file: readable like the rest of the project, and its folder left as it is.
      await writePrivateFileAtomicAsync(path.join(folder, WORKSPACE_FILE), content, { mode: 0o644, protectDirectory: false });
    } else {
      throw new Error("Choose the global or the workspace AGENTS.md");
    }
    return read(workspaceId);
  }
  /**
   * The block a launch puts in front of its message, and a fingerprint of the files, so a running
   * agent is given it again only once they changed. Empty when neither file has anything in it.
   * `maxBytes`: the room the message leaves (AO keeps only the first 16 KiB of a new agent's prompt,
   * and the person's own request is never the part cut). A file cut to fit says where the rest is,
   * and with no room for any text the block still names both files for the agent to read.
   */
  async function forLaunch(workspaceId, { maxBytes = 2 * MAX_PROMPT_BYTES } = {}) {
    const { global, globalFile: globalPath, workspace, workspaceFile } = await read(workspaceId);
    const files = [
      { title: "Global AGENTS.md, for every project", where: globalPath, body: global.trim() },
      { title: "Workspace AGENTS.md, for this project", where: workspaceFile, body: workspace === null ? "" : workspace.trim() },
    ].filter((file) => file.body);
    if (!files.length) return { text: "", hash: "" };
    const hash = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
    const wrap = (inner) => ["<user_instructions>",
      "The user's standing instructions, from their global and workspace AGENTS.md files. Follow them for the whole of this chat, before anything else in the project's files.",
      "", inner, "</user_instructions>", "", ""].join("\n");
    const pointer = wrap(files.map((file) => `Read ${file.where} (${file.title}) before you start, and follow it.`).join("\n"));
    const overhead = utf8Bytes(wrap(files.map((file) => `## ${file.title} (${file.where})\n\n\n\n[Cut here: the rest is in ${file.where}; read it before you go on.]`).join("\n\n")));
    const each = Math.min(MAX_PROMPT_BYTES, Math.floor((maxBytes - overhead) / files.length));
    if (each < 256) return utf8Bytes(pointer) <= maxBytes ? { text: pointer, hash } : { text: "", hash: "" };
    const text = wrap(files.map((file) => {
      const kept = utf8Prefix(file.body, each);
      const cut = kept.length < file.body.length ? `\n\n[Cut here: the rest is in ${file.where}; read it before you go on.]` : "";
      return `## ${file.title} (${file.where})\n\n${kept}${cut}`;
    }).join("\n\n"));
    return { text, hash };
  }
  return { read, save, forLaunch, projects, workspaceFolder };
}

module.exports = { createAgentInstructions, WORKSPACE_FILE, MAX_PROMPT_BYTES, MAX_SAVE_BYTES };
