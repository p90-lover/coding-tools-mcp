"use strict";

const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
// browser-accounts.cjs ids: the first account is "main", added ones 12 lowercase letters/digits.
const ACCOUNT_ID = /^(?:main|[a-z0-9]{12})$/;

const isThreadId = (value) => typeof value === "string" && THREAD_ID.test(value);

/**
 * Which ChatGPT account (browser-accounts.cjs) each Codex thread runs on. A thread is bound to the
 * account in use when its first turn starts and keeps it: later turns reopen its saved chat on that
 * account, whichever account the Browser tab shows. Moving a thread starts a new chat on the new
 * account (the bridge sends the whole task then); its old chats stay with the old account.
 */
function createThreadAccounts({ filePath, io = fs, now = Date.now, logger = null }) {
  const threads = new Map(); // threadId -> { accountId, boundAt, lastUsedAt }
  let unavailable = false;
  if (io.existsSync(filePath)) {
    try {
      const saved = JSON.parse(io.readFileSync(filePath, "utf8"));
      if (saved?.version !== 1 || typeof saved.threads !== "object" || !saved.threads) {
        throw new Error("Codex thread account registry is invalid");
      }
      for (const [threadId, entry] of Object.entries(saved.threads)) {
        if (!isThreadId(threadId) || !ACCOUNT_ID.test(entry?.accountId ?? "")) continue;
        threads.set(threadId.toLowerCase(), {
          accountId: entry.accountId,
          boundAt: Number.isFinite(entry.boundAt) ? entry.boundAt : now(),
          lastUsedAt: Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : now(),
        });
      }
    } catch (error) {
      // Keep the unreadable file for recovery and never overwrite it; threads use the active account.
      threads.clear();
      unavailable = true;
      logger?.warn?.("browser.thread_accounts_unavailable", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const save = () => {
    if (unavailable) return;
    writePrivateFileAtomic(filePath, `${JSON.stringify({ version: 1, threads: Object.fromEntries(threads) }, null, 2)}\n`);
  };

  return {
    accountFor(threadId) {
      return isThreadId(threadId) ? threads.get(threadId.toLowerCase())?.accountId ?? null : null;
    },

    /** Binds a thread (first turn, or a move) and returns its account; refreshes lastUsedAt. */
    bind(threadId, accountId) {
      if (!isThreadId(threadId)) throw new Error("Not a Codex thread id");
      if (!ACCOUNT_ID.test(accountId ?? "")) throw new Error("Not a ChatGPT account id");
      const id = threadId.toLowerCase();
      const previous = threads.get(id);
      const at = now();
      threads.set(id, {
        accountId,
        boundAt: previous?.accountId === accountId ? previous.boundAt : at,
        lastUsedAt: at,
      });
      save();
      return accountId;
    },

    unbind(threadId) {
      if (!isThreadId(threadId) || !threads.delete(threadId.toLowerCase())) return false;
      save();
      return true;
    },

    /** Drops a removed account's bindings: those threads start fresh on the account in use. */
    removeAccount(accountId) {
      let changed = false;
      for (const [threadId, entry] of threads) {
        if (entry.accountId === accountId) changed = threads.delete(threadId) || changed;
      }
      if (changed) save();
      return changed;
    },

    list() {
      return [...threads].map(([threadId, entry]) => ({ threadId, ...entry }))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    },
  };
}

module.exports = { createThreadAccounts, isThreadId };
