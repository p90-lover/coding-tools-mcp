"use strict";

// Not called since 0.8.85: the GPT Browser is its own browser again, and gpt-browser-restore.cjs
// gives back the accounts this moved. Kept for its tests and as the record of what the merge did.

/**
 * GPT Browser and the Browser tab become one browser: the GPT Browser page shows the Browser tab's
 * engine (browser-host.cjs), which the Codex bridge drives. This moves the GPT Browser's own
 * accounts into the Browser tab's list once, at startup, before either browser opens a session:
 *
 * - Each account joins browser-accounts.cjs under its own id when free, and its Chromium partition
 *   folder (Partitions/gpt-browser-<id>) is renamed to that account's (Partitions/coding-tools-
 *   chatgpt-<id>), so its sign-in, cookies and storage come along; no one signs in again.
 * - An account whose email the list already has is a second sign-in to the same ChatGPT account:
 *   it isn't added, and its partition folder goes to Trash rather than being deleted.
 * - The list holds 12 accounts; ones that don't fit stay in the GPT Browser's file, untouched.
 * - The registry entry is saved before the folder moves. A start that stopped between the two finds
 *   the entry and its folder still unmoved, and finishes the move.
 *
 * Every call is async: this runs on Electron main at startup (main-sync-calls.test.cjs).
 */

const fs = require("node:fs");
const path = require("node:path");

const GPT_ACCOUNT_ID = /^[a-z0-9]{12}$/;
const STATE_FILE = "accounts.json";
const MERGED_FILE = "accounts.merged.json";

const folderOf = (partition) => String(partition).replace(/^persist:/u, "");
const exists = (target) => fs.promises.stat(target).then(() => true, () => false);

async function readGptAccounts(dataRoot) {
  let text;
  try { text = await fs.promises.readFile(path.join(dataRoot, STATE_FILE), "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const saved = JSON.parse(text);
  if (!Array.isArray(saved?.accounts)) throw new Error("GPT Browser accounts.json has no accounts list");
  return {
    saved,
    accounts: saved.accounts.filter((entry) => GPT_ACCOUNT_ID.test(entry?.id)).map((entry) => ({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : null,
      email: typeof entry.email === "string" && entry.email.includes("@") ? entry.email : null,
    })),
  };
}

/**
 * Moves the GPT Browser's accounts into `accounts` (createBrowserAccounts). `partitionsRoot` is
 * <userData>/Partitions; `trashRoot` takes the folders of accounts that were already in the list.
 * Returns { merged: [{ from, to }], duplicates: [id], left: [id] }.
 */
async function mergeGptBrowserAccounts({ gptDataRoot, partitionsRoot, trashRoot, accounts, logger = console, now = () => Date.now() }) {
  const result = { merged: [], duplicates: [], left: [] };
  const read = await readGptAccounts(gptDataRoot);
  if (!read) return result;
  const known = new Set(accounts.status().accounts.map((entry) => entry.email?.toLowerCase()).filter(Boolean));
  const source = (id) => path.join(partitionsRoot, `gpt-browser-${id}`);
  const target = (id) => path.join(partitionsRoot, folderOf(accounts.partitionOf(id)));
  const kept = [];
  const listed = (id) => accounts.status().accounts.find((entry) => entry.id === id) ?? null;
  // The listed entry is this account itself (an earlier start saved it), not another under the same id.
  const sameAccount = (entry, account) => (entry.email || account.email
    ? entry.email?.toLowerCase() === account.email?.toLowerCase()
    : entry.label === (account.label ?? entry.label));
  for (const account of read.accounts) {
    const from = source(account.id);
    // A start that stopped after saving the entry: the account is listed and its folder unmoved.
    const earlier = listed(account.id);
    if (earlier && sameAccount(earlier, account) && await exists(from) && !await exists(target(account.id))) {
      await fs.promises.rename(from, target(account.id));
      result.merged.push({ from: account.id, to: account.id });
      continue;
    }
    if (account.email && known.has(account.email.toLowerCase())) {
      if (await exists(from)) {
        await fs.promises.mkdir(trashRoot, { recursive: true });
        await fs.promises.rename(from, path.join(trashRoot, `gpt-browser-${account.id}-${now()}`));
      }
      result.duplicates.push(account.id);
      continue;
    }
    const taken = new Set();
    for (const entry of read.accounts) if (entry !== account) taken.add(entry.id);
    // An id is free only if no folder of that name is waiting either (a removed account's leftover).
    let id = null;
    for (let attempt = 0; attempt < 5 && !id; attempt += 1) {
      const candidate = accounts.adopt({ id: attempt === 0 ? account.id : undefined, label: account.label, email: account.email }, (other) => taken.has(other));
      if (!candidate) break;
      if (!await exists(target(candidate))) { id = candidate; break; }
      accounts.unadopt(candidate);
      taken.add(candidate);
    }
    if (!id) { kept.push(account.id); continue; }
    await accounts.saved();
    try {
      if (await exists(from)) await fs.promises.rename(from, target(id));
    } catch (error) {
      // The folder is in use or can't move: the account stays the GPT Browser's.
      accounts.unadopt(id);
      await accounts.saved();
      logger.warn?.("gpt_browser_merge.move_failed", { id: account.id, message: error instanceof Error ? error.message : String(error) });
      kept.push(account.id);
      continue;
    }
    if (account.email) known.add(account.email.toLowerCase());
    result.merged.push({ from: account.id, to: id });
  }
  result.left = kept;
  const statePath = path.join(gptDataRoot, STATE_FILE);
  if (kept.length) {
    // What didn't fit stays listed for the next start, and nothing else.
    const rest = { ...read.saved, accounts: read.saved.accounts.filter((entry) => kept.includes(entry?.id)) };
    await fs.promises.writeFile(`${statePath}.tmp`, `${JSON.stringify(rest, null, 2)}\n`);
    await fs.promises.rename(`${statePath}.tmp`, statePath);
  } else {
    await fs.promises.rename(statePath, path.join(gptDataRoot, MERGED_FILE));
  }
  logger.info?.("gpt_browser_merge.done", { merged: result.merged.length, duplicates: result.duplicates.length, left: kept.length });
  return result;
}

module.exports = { mergeGptBrowserAccounts };
