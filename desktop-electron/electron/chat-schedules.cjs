"use strict";

// /schedule: the person asks a chat to go on by itself later ("/schedule 5h", "/schedule 9am run the
// tests again"). At that time the chat is sent a message (by default, to continue where it left off),
// as if the person typed it then. Typical use: a chat stopped on a usage limit that resets in five
// hours, or work to pick up after a long job or the next morning.
//
// Unlike an agent's wake-up (chat-wakeups.cjs), a schedule is the person's: a message they send
// meanwhile does not cancel it, and neither does an agent's schedule_wakeup. It is deleted with
// /clearschedule, from the chat details (right-click › Delete schedule), or when it has been sent.
// One schedule per chat ("<workspace>:<task>"); a new one replaces it.

const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

const MIN_SCHEDULE_MS = 60_000;
const MAX_SCHEDULE_MS = 30 * 24 * 60 * 60_000;
const SCHEDULE_MESSAGE_LIMIT = 4000;
const DEFAULT_SCHEDULE_MESSAGE = "Continue";

/** A schedule's due time (epoch ms) and message, checked; throws with what the person should fix. */
function cleanSchedule({ dueAt, message } = {}, at = Date.now()) {
  if (!Number.isSafeInteger(dueAt)) throw new Error("Say when, like /schedule 5h or /schedule 9:30");
  if (dueAt < at + MIN_SCHEDULE_MS - 1_000) throw new Error("A schedule must be at least 1 minute from now");
  if (dueAt > at + MAX_SCHEDULE_MS) throw new Error("A schedule can be at most 30 days from now");
  const text = String(message ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (text.length > SCHEDULE_MESSAGE_LIMIT) {
    throw new Error(`A scheduled message can be at most ${SCHEDULE_MESSAGE_LIMIT.toLocaleString("en-US")} characters`);
  }
  return { dueAt, message: text || DEFAULT_SCHEDULE_MESSAGE, custom: Boolean(text) };
}

/** A span of time, the way the chat writes it: "45m", "5h", "2h 30m", "1d 3h". */
function scheduleSpan(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return `${rest}m`;
}

/**
 * The message a due schedule sends its chat. `schedule` has `message` (the person's words, or
 * "Continue" when they gave none), `custom` (whether they gave words), `scheduledAt` and `dueAt`
 * (epoch ms); `at` is now.
 *
 * The person's own words go as they typed them: it shows in the chat as their message. Without
 * words, "Continue" alone hours later reads as if no time had passed, so it says how long ago it
 * was scheduled, and that things may have changed since (files, jobs that were running, a usage
 * limit that has reset).
 */
function scheduleMessage(schedule, at = Date.now()) {
  if (schedule.custom) return schedule.message;
  const since = at - schedule.scheduledAt;
  if (!Number.isFinite(since) || since < MIN_SCHEDULE_MS) return schedule.message;
  return `${schedule.message}. (Scheduled ${scheduleSpan(since)} ago: check what has changed since then before you carry on.)`;
}

/**
 * What a due schedule does now, given its chat ({ active, working }): "send" its message, "wait"
 * for the chat's running turn (it is sent once that settles), or "drop" it (the chat was archived
 * or deleted). A message the person sent meanwhile does not end it.
 */
function scheduleAction(_schedule, chat) {
  if (!chat?.active) return "drop";
  return chat.working ? "wait" : "send";
}

/** The saved schedules, in a small JSON file so one survives an app restart. Without a file (tests) they live in memory. */
function createScheduleStore({ file = null, now = Date.now } = {}) {
  let schedules = {};
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) schedules = saved;
    } catch { /* No schedules saved yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  // Saved off the main thread, as the goals are (chat-goals.cjs): a synchronous write here held every
  // window for as long as the busy hard disk took, on each /schedule, send and delete. Flushed before
  // it replaces the old file, so a power cut leaves the old schedules or the new ones; a burst of
  // changes is one save plus at most one more with the latest.
  let saving = null;
  let saveAgain = false;
  const persist = () => {
    if (!file) return;
    if (saving) { saveAgain = true; return; }
    saving = writePrivateFileAtomicAsync(file, JSON.stringify(schedules, null, 2), { durable: true, protectDirectory: false })
      .catch(() => { /* the old file stays; the next change saves every schedule again */ })
      .finally(() => {
        saving = null;
        if (saveAgain) { saveAgain = false; persist(); }
      });
  };
  return {
    /** Resolves once every change so far is on disk (tests, and a caller about to exit). */
    async saved() { while (saving) await saving; },
    get: (workspaceId, taskId) => schedules[key(workspaceId, taskId)] ?? null,
    /** Every schedule of one project, by chat. */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(schedules).filter(([name]) => name.startsWith(prefix)).map(([name, schedule]) => [name.slice(prefix.length), schedule]));
    },
    /** Every saved schedule, for arming the timers when the app starts. */
    all: () => Object.values(schedules).map((schedule) => ({ workspaceId: schedule.workspaceId, taskId: schedule.taskId, schedule })),
    /** `spec` is what the person typed for the time ("5h", "9:30"), kept to show it back. */
    set(workspaceId, taskId, { dueAt, message, spec = "" }) {
      const at = now();
      const checked = cleanSchedule({ dueAt, message }, at);
      const schedule = { id: `sched-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, workspaceId, taskId, ...checked,
        spec: String(spec).slice(0, 80), scheduledAt: at, due: false, note: "" };
      schedules[key(workspaceId, taskId)] = schedule;
      persist();
      return schedule;
    },
    update(workspaceId, taskId, change) {
      const schedule = schedules[key(workspaceId, taskId)];
      if (!schedule) return null;
      Object.assign(schedule, change);
      persist();
      return schedule;
    },
    /** A chat that moved to another project (move_chat) keeps its schedule there. */
    move(from, to, taskId) {
      const saved = schedules[key(from, taskId)];
      if (!saved) return false;
      delete schedules[key(from, taskId)];
      schedules[key(to, taskId)] = { ...saved, workspaceId: to };
      persist();
      return true;
    },
    /** Removes the chat's schedule (only `id` when given, so a newer one is never cleared by mistake). */
    clear(workspaceId, taskId, id = null) {
      const schedule = schedules[key(workspaceId, taskId)];
      if (!schedule || (id && schedule.id !== id)) return false;
      delete schedules[key(workspaceId, taskId)];
      persist();
      return true;
    },
  };
}

module.exports = {
  MIN_SCHEDULE_MS, MAX_SCHEDULE_MS, SCHEDULE_MESSAGE_LIMIT, DEFAULT_SCHEDULE_MESSAGE,
  cleanSchedule, scheduleSpan, scheduleMessage, scheduleAction, createScheduleStore,
};
