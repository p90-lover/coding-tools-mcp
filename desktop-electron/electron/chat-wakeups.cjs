"use strict";

// Chat wake-ups, as Claude Code's ScheduleWakeup: an agent waiting on something slow (a build, CI,
// a long job, a server coming up) ends its turn with schedule_wakeup instead of sleeping or polling
// in it, and the chat sends it a follow-up after the minutes it chose. A turn that waits burns
// tokens on every poll; a chat that sleeps costs nothing until it is woken.
//
// One wake-up per chat ("<workspace>:<task>"); a new one replaces it. It belongs to the run that
// asked for it: a newer message in the chat (the user's own, or a goal's next round) supersedes it.

const fs = require("node:fs");
const path = require("node:path");

const MIN_WAKE_MINUTES = 1;
const MAX_WAKE_MINUTES = 720;
const REASON_LIMIT = 500;

/** The minutes and note of a schedule_wakeup call, checked; throws with what the agent should fix. */
function cleanWakeup({ minutes, reason } = {}) {
  if (!Number.isSafeInteger(minutes) || minutes < MIN_WAKE_MINUTES || minutes > MAX_WAKE_MINUTES) {
    throw new Error(`minutes must be a whole number from ${MIN_WAKE_MINUTES} to ${MAX_WAKE_MINUTES}`);
  }
  const note = String(reason ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!note) throw new Error("reason must say what to check when you wake (e.g. \"see whether the CI run passed\")");
  if (note.length > REASON_LIMIT) throw new Error(`reason can be at most ${REASON_LIMIT} characters`);
  return { minutes, reason: note };
}

/** The follow-up a woken chat gets: when it asked, its own note, and to sleep again rather than poll. */
function wakePrompt(wakeup, at = Date.now()) {
  const elapsed = Math.max(1, Math.round((at - wakeup.scheduledAt) / 60_000));
  return [
    `Wake-up: ${elapsed} minute${elapsed === 1 ? "" : "s"} ago you asked to be woken (schedule_wakeup, ${wakeup.minutes} min).`,
    `Your note: ${wakeup.reason}`,
    "",
    "Pick up from there. If what you are waiting for is still not ready, call schedule_wakeup again and end your turn "
      + "instead of waiting or polling in it.",
  ].join("\n");
}

/**
 * What a wake-up that is due does now, given its chat: "send" the follow-up, "wait" for the chat's
 * running turn to settle (it fires then), or "drop" it. `chat` is { active, latestRunId, working }:
 * whether the chat is still shown (not archived or deleted), the id of its newest run, and whether a
 * turn of it is running now. The wake-up was asked for by run `wakeup.runId`.
 */
function wakeupAction(wakeup, chat) {
  if (!chat?.active) return "drop";
  // Someone spoke after it was asked for (the user, or a goal's next round): that turn has the floor.
  // A self-paced /loop's next round (chat-loops.cjs) still comes, as Claude Code's does.
  if (!wakeup.loop && chat.latestRunId !== wakeup.runId) return "drop";
  // Usually the very turn that asked, still finishing: wake once it settles.
  return chat.working ? "wait" : "send";
}

/**
 * The saved wake-ups, kept in a small JSON file so one survives an app restart (an overdue one
 * fires shortly after the app is back). Without a file (tests) they live in memory.
 */
function createWakeupStore({ file = null, now = Date.now } = {}) {
  let wakeups = {};
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) wakeups = saved;
    } catch { /* No wake-ups saved yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(wakeups, null, 2));
    fs.renameSync(temporary, file);
  };
  return {
    get: (workspaceId, taskId) => wakeups[key(workspaceId, taskId)] ?? null,
    /** Every wake-up of one project, by chat. */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(wakeups).filter(([name]) => name.startsWith(prefix)).map(([name, wakeup]) => [name.slice(prefix.length), wakeup]));
    },
    /** Every saved wake-up, for arming the timers when the app starts. */
    all: () => Object.entries(wakeups).map(([name, wakeup]) => ({ workspaceId: wakeup.workspaceId, taskId: wakeup.taskId, name, wakeup })),
    /** `loop`: the wake-up paces a self-paced /loop, whose next round it starts. */
    set(workspaceId, taskId, { minutes, reason, session, runId, loop = false }) {
      const at = now();
      const checked = cleanWakeup({ minutes, reason });
      const wakeup = { id: `wake-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, workspaceId, taskId,
        ...checked, session: String(session), runId: String(runId), scheduledAt: at, dueAt: at + checked.minutes * 60_000, due: false,
        ...(loop ? { loop: true } : {}) };
      wakeups[key(workspaceId, taskId)] = wakeup;
      persist();
      return wakeup;
    },
    update(workspaceId, taskId, change) {
      const wakeup = wakeups[key(workspaceId, taskId)];
      if (!wakeup) return null;
      Object.assign(wakeup, change);
      persist();
      return wakeup;
    },
    /**
     * The user's change to the chat's wake-up `id`: its note and/or the minutes from now, checked as
     * the agent's own are. A new time restarts the clock. Null when that wake-up is gone or replaced.
     */
    edit(workspaceId, taskId, id, { minutes, reason } = {}) {
      const wakeup = wakeups[key(workspaceId, taskId)];
      if (!wakeup || wakeup.id !== id) return null;
      const checked = cleanWakeup({ minutes: minutes ?? wakeup.minutes, reason: reason ?? wakeup.reason });
      const at = now();
      Object.assign(wakeup, checked, minutes === undefined ? {} : { scheduledAt: at, dueAt: at + checked.minutes * 60_000, due: false });
      persist();
      return wakeup;
    },
    /** A chat that moved to another project (move_chat) keeps its wake-up there. */
    move(from, to, taskId) {
      const saved = wakeups[key(from, taskId)];
      if (!saved) return false;
      delete wakeups[key(from, taskId)];
      wakeups[key(to, taskId)] = { ...saved, workspaceId: to };
      persist();
      return true;
    },
    /** Removes the chat's wake-up (only `id` when given, so a newer one is never cleared by mistake). */
    clear(workspaceId, taskId, id = null) {
      const wakeup = wakeups[key(workspaceId, taskId)];
      if (!wakeup || (id && wakeup.id !== id)) return false;
      delete wakeups[key(workspaceId, taskId)];
      persist();
      return true;
    },
  };
}

module.exports = { MIN_WAKE_MINUTES, MAX_WAKE_MINUTES, REASON_LIMIT, cleanWakeup, wakePrompt, wakeupAction, createWakeupStore };
