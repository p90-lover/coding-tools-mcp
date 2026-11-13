"use strict";

// Archived chats: when each was archived, and after how many days an archived chat moves on to the
// recoverable "deleted" state (still listed under Archived › Recently deleted, still restorable),
// and after how many days without activity an open chat is archived (idleDays), so the project
// list stops loading it. Nothing is erased. Kept in a small JSON file so it survives restarts; without one (tests) it
// lives in memory. A change is in memory at once and saved off the main thread (as chat-edits.cjs
// and chat-goals.cjs are): archiving, restoring or listing chats no longer waits on the disk with
// every window held.

const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const DEFAULT_ARCHIVE_DAYS = 5;
const DEFAULT_IDLE_DAYS = 7;
const MAX_ARCHIVE_DAYS = 365;
const DAY_MS = 86_400_000;

const validDays = (days) => Number.isSafeInteger(days) && days >= 0 && days <= MAX_ARCHIVE_DAYS;

function createChatArchiveStore({ file = null, now = Date.now, logger = null } = {}) {
  let state = { days: DEFAULT_ARCHIVE_DAYS, idleDays: DEFAULT_IDLE_DAYS, archived: {}, restored: {} };
  const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        state = {
          days: validDays(saved.days) ? saved.days : DEFAULT_ARCHIVE_DAYS,
          idleDays: validDays(saved.idleDays) ? saved.idleDays : DEFAULT_IDLE_DAYS,
          archived: record(saved.archived),
          restored: record(saved.restored),
        };
      }
    } catch { /* Nothing archived yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  // One save at a time; changes made meanwhile go in one more save after it (a listing can date
  // several archived chats in a row).
  let saving = null;
  let saveAgain = false;
  const persist = () => {
    if (!file) return;
    if (saving) { saveAgain = true; return; }
    saving = writePrivateFileAtomicAsync(file, JSON.stringify(state, null, 2), { durable: true, protectDirectory: false })
      .catch((error) => logger?.warn?.("chat_archive.not_saved", { message: String(error?.message ?? error).slice(0, 200) }))
      .finally(() => {
        saving = null;
        if (saveAgain) { saveAgain = false; persist(); }
      });
  };
  return {
    /** Resolves once every change so far is on disk, or has failed to get there (a caller about to exit, tests). */
    async saved() { while (saving) await saving; },
    /** Days an archived chat stays archived; 0 keeps it there for good. */
    days: () => state.days,
    setDays(days) {
      if (!validDays(days)) throw new Error(`Choose 0 to ${MAX_ARCHIVE_DAYS} days`);
      state.days = days;
      persist();
      return days;
    },
    /** Days without activity before an open chat is archived; 0 never archives one by itself. */
    idleDays: () => state.idleDays,
    setIdleDays(days) {
      if (!validDays(days)) throw new Error(`Choose 0 to ${MAX_ARCHIVE_DAYS} days`);
      state.idleDays = days;
      persist();
      return days;
    },
    /** The moment before which a chat's last activity makes it idle, or 0 when nothing is archived by itself. */
    idleCutoff: () => (state.idleDays > 0 ? now() - state.idleDays * DAY_MS : 0),
    /** Records the moment a chat was archived. */
    archived(workspaceId, taskId) { state.archived[key(workspaceId, taskId)] = now(); persist(); },
    /** A restored or deleted chat no longer counts down. */
    forget(workspaceId, taskId) {
      if (!(key(workspaceId, taskId) in state.archived)) return;
      delete state.archived[key(workspaceId, taskId)];
      persist();
    },
    /**
     * A chat brought back by Restore: that counts as activity, so the idle sweep leaves it open for
     * idleDays from now. It archived the chat again within seconds, its last turn being as old as before.
     */
    restored(workspaceId, taskId) {
      delete state.archived[key(workspaceId, taskId)];
      state.restored[key(workspaceId, taskId)] = now();
      persist();
    },
    /** When the chat was last restored (Unix ms), or 0. */
    restoredAt: (workspaceId, taskId) => (Number.isFinite(state.restored[key(workspaceId, taskId)]) ? state.restored[key(workspaceId, taskId)] : 0),
    /** The chats of a project this store counts days for: archived ones whose runs the project read may no longer hold. */
    archivedIn: (workspaceId) => Object.keys(state.archived).filter((id) => id.startsWith(`${workspaceId}:`)).map((id) => id.slice(workspaceId.length + 1)),
    /**
     * When the chat was archived. One archived before this was kept (an older app) is taken as
     * archived the first time it is seen, so it gets its full days rather than going at once.
     */
    since(workspaceId, taskId) {
      const id = key(workspaceId, taskId);
      if (!Number.isFinite(state.archived[id])) { state.archived[id] = now(); persist(); }
      return state.archived[id];
    },
    /** Whether an archived chat's days are up. */
    due(workspaceId, taskId) {
      return state.days > 0 && now() - this.since(workspaceId, taskId) >= state.days * DAY_MS;
    },
  };
}

module.exports = { createChatArchiveStore, DEFAULT_ARCHIVE_DAYS, DEFAULT_IDLE_DAYS, MAX_ARCHIVE_DAYS };
