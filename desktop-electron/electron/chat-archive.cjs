"use strict";

// Archived chats: when each was archived, and after how many days an archived chat moves on to the
// recoverable "deleted" state (still listed under Archived › Recently deleted, still restorable).
// Nothing is erased. Kept in a small JSON file so it survives restarts; without one (tests) it
// lives in memory.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ARCHIVE_DAYS = 5;
const MAX_ARCHIVE_DAYS = 365;
const DAY_MS = 86_400_000;

function createChatArchiveStore({ file = null, now = Date.now } = {}) {
  let state = { days: DEFAULT_ARCHIVE_DAYS, archived: {} };
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        state = {
          days: Number.isSafeInteger(saved.days) && saved.days >= 0 && saved.days <= MAX_ARCHIVE_DAYS ? saved.days : DEFAULT_ARCHIVE_DAYS,
          archived: saved.archived && typeof saved.archived === "object" && !Array.isArray(saved.archived) ? saved.archived : {},
        };
      }
    } catch { /* Nothing archived yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
    fs.renameSync(temporary, file);
  };
  return {
    /** Days an archived chat stays archived; 0 keeps it there for good. */
    days: () => state.days,
    setDays(days) {
      if (!Number.isSafeInteger(days) || days < 0 || days > MAX_ARCHIVE_DAYS) throw new Error(`Choose 0 to ${MAX_ARCHIVE_DAYS} days`);
      state.days = days;
      persist();
      return days;
    },
    /** Records the moment a chat was archived. */
    archived(workspaceId, taskId) { state.archived[key(workspaceId, taskId)] = now(); persist(); },
    /** A restored or deleted chat no longer counts down. */
    forget(workspaceId, taskId) {
      if (!(key(workspaceId, taskId) in state.archived)) return;
      delete state.archived[key(workspaceId, taskId)];
      persist();
    },
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

module.exports = { createChatArchiveStore, DEFAULT_ARCHIVE_DAYS, MAX_ARCHIVE_DAYS };
