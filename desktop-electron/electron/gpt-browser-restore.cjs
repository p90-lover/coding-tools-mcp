"use strict";

/**
 * The GPT Browser is its own browser again (2026-11-04). #1044 had moved its accounts into the
 * Browser tab's list: accounts.json became accounts.merged.json, each account's partition folder
 * (Partitions/gpt-browser-<id>) was renamed to the Browser tab's (Partitions/coding-tools-chatgpt-
 * <id>), and a second sign-in to an account the list already had went to Trash. This gives the GPT
 * Browser its accounts back once, at startup, before any partition opens:
 *
 * - A folder that went to Trash comes back (the newest one for that id).
 * - A folder that became a Browser tab account is copied back, caches left out, so the GPT Browser
 *   keeps its sign-in and the Browser tab (which the Codex bridge uses) keeps the account too.
 * - accounts.json is written again from accounts.merged.json, which stays as it is. An existing
 *   accounts.json means there is nothing to restore.
 *
 * Every call is async: this runs on Electron main at startup (main-sync-calls.test.cjs).
 */

const fs = require("node:fs");
const path = require("node:path");

const GPT_ACCOUNT_ID = /^[a-z0-9]{12}$/;
const STATE_FILE = "accounts.json";
const MERGED_FILE = "accounts.merged.json";
// Chromium rebuilds these on its own; copying them only costs disk on the shared HDD.
const CACHE_DIRS = new Set(["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "CacheStorage", "ScriptCache"]);

const exists = (target) => fs.promises.stat(target).then(() => true, () => false);

async function newestTrashFolder(trashRoot, id) {
  const names = await fs.promises.readdir(trashRoot).catch(() => []);
  const stamp = (name) => Number(name.slice(`gpt-browser-${id}-`.length)) || 0;
  const mine = names.filter((name) => name.startsWith(`gpt-browser-${id}-`)).sort((a, b) => stamp(b) - stamp(a));
  return mine.length ? path.join(trashRoot, mine[0]) : null;
}

/**
 * Restores the GPT Browser's accounts that #1044 merged. `partitionsRoot` is <userData>/Partitions,
 * `trashRoot` the merge's Trash folder. Returns { restored: [{ id, from }], missing: [id] }, or null
 * when there was nothing to restore.
 */
async function restoreGptBrowserAccounts({ gptDataRoot, partitionsRoot, trashRoot, logger = console }) {
  const statePath = path.join(gptDataRoot, STATE_FILE);
  if (await exists(statePath)) return null;
  let text;
  try { text = await fs.promises.readFile(path.join(gptDataRoot, MERGED_FILE), "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const saved = JSON.parse(text);
  if (!Array.isArray(saved?.accounts)) throw new Error("GPT Browser accounts.merged.json has no accounts list");
  const result = { restored: [], missing: [] };
  for (const account of saved.accounts.filter((entry) => GPT_ACCOUNT_ID.test(entry?.id))) {
    const target = path.join(partitionsRoot, `gpt-browser-${account.id}`);
    if (await exists(target)) continue;
    const trashed = await newestTrashFolder(trashRoot, account.id);
    if (trashed) {
      await fs.promises.rename(trashed, target);
      result.restored.push({ id: account.id, from: "trash" });
      continue;
    }
    const merged = path.join(partitionsRoot, `coding-tools-chatgpt-${account.id}`);
    if (await exists(merged)) {
      // Copied into a temporary name first: a start that stops mid-copy leaves no half partition.
      const partial = `${target}.restoring`;
      await fs.promises.rm(partial, { recursive: true, force: true });
      await fs.promises.cp(merged, partial, { recursive: true, filter: (source) => !CACHE_DIRS.has(path.basename(source)) });
      await fs.promises.rename(partial, target);
      result.restored.push({ id: account.id, from: "browser" });
      continue;
    }
    result.missing.push(account.id);
  }
  await fs.promises.writeFile(`${statePath}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
  await fs.promises.rename(`${statePath}.tmp`, statePath);
  logger.info?.("gpt_browser_restore.done", { restored: result.restored.length, missing: result.missing.length });
  return result;
}

module.exports = { restoreGptBrowserAccounts };
