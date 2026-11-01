"use strict";

// /loop, as Claude Code's: a chat runs one prompt again and again. With an interval ("/loop 5m
// check the deploy") the prompt is sent now and then every interval, a round that comes due while
// the chat works waiting for its turn to end. Without one ("/loop check the deploy") the agent paces
// itself: each round it calls schedule_wakeup with how long until the next, and the chat sends the
// prompt again then; a round that schedules nothing ends the loop. As Claude Code's recurring tasks,
// a loop ends by itself after seven days.
//
// One loop per chat ("<workspace>:<task>"); a new one replaces it.

const fs = require("node:fs");
const path = require("node:path");

const MIN_LOOP_MINUTES = 1;
const MAX_LOOP_MINUTES = 1440;
const LOOP_PROMPT_LIMIT = 4000;
const LOOP_LIFETIME_MS = 7 * 24 * 60 * 60_000;

/** A /loop's prompt and interval (whole minutes, or null when the agent paces itself), checked. */
function cleanLoop({ prompt, minutes } = {}) {
  if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < MIN_LOOP_MINUTES || minutes > MAX_LOOP_MINUTES)) {
    throw new Error(`The interval must be ${MIN_LOOP_MINUTES} minute to ${MAX_LOOP_MINUTES / 60} hours`);
  }
  const text = String(prompt ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text) throw new Error("Say what to run each time: /loop 5m check the deploy");
  if (text.length > LOOP_PROMPT_LIMIT) throw new Error(`A loop's prompt can be at most ${LOOP_PROMPT_LIMIT.toLocaleString("en-US")} characters`);
  return { prompt: text, minutes };
}

/**
 * The message a round sends. A loop on an interval sends its prompt as it is, as Claude Code's does;
 * a self-paced one also tells the agent how to go on or stop, with the note it left last round.
 */
function loopMessage(loop, note = "") {
  if (loop.minutes !== null) return loop.prompt;
  return [
    loop.prompt,
    "",
    ...(note ? [`(Your note from the last round: ${note})`, ""] : []),
    "This is a self-paced /loop. When this round is done, call schedule_wakeup with how many minutes until the next round "
      + "should run and a note of what to look at then; the chat sends you this prompt again at that time. To end the loop, "
      + "finish your turn without calling schedule_wakeup.",
  ].join("\n");
}

/**
 * What a loop's due round does now, given its chat ({ active, working }): "send" it, "wait" for the
 * chat's running turn (it is sent once that settles), or "drop" the loop (the chat was archived or
 * deleted, or the loop outlived its seven days). Unlike a wake-up, a message the user sent meanwhile
 * does not end the loop.
 */
function loopAction(loop, chat, at = Date.now()) {
  if (!chat?.active || at >= loop.expiresAt) return "drop";
  return chat.working ? "wait" : "send";
}

/** The saved loops, in a small JSON file so one survives an app restart. Without a file (tests) they live in memory. */
function createLoopStore({ file = null, now = Date.now } = {}) {
  let loops = {};
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) loops = saved;
    } catch { /* No loops saved yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(loops, null, 2));
    fs.renameSync(temporary, file);
  };
  return {
    get: (workspaceId, taskId) => loops[key(workspaceId, taskId)] ?? null,
    /** Every loop of one project, by chat. */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(loops).filter(([name]) => name.startsWith(prefix)).map(([name, loop]) => [name.slice(prefix.length), loop]));
    },
    /** Every saved loop, for arming the timers when the app starts. */
    all: () => Object.values(loops).map((loop) => ({ workspaceId: loop.workspaceId, taskId: loop.taskId, loop })),
    set(workspaceId, taskId, { prompt, minutes }) {
      const at = now();
      const checked = cleanLoop({ prompt, minutes });
      const loop = { id: `loop-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, workspaceId, taskId, ...checked,
        startedAt: at, expiresAt: at + LOOP_LIFETIME_MS, round: 0, lastRunId: "", nextAt: at, due: false };
      loops[key(workspaceId, taskId)] = loop;
      persist();
      return loop;
    },
    update(workspaceId, taskId, change) {
      const loop = loops[key(workspaceId, taskId)];
      if (!loop) return null;
      Object.assign(loop, change);
      persist();
      return loop;
    },
    /** A chat that moved to another project (move_chat) keeps its loop there. */
    move(from, to, taskId) {
      const saved = loops[key(from, taskId)];
      if (!saved) return false;
      delete loops[key(from, taskId)];
      loops[key(to, taskId)] = { ...saved, workspaceId: to };
      persist();
      return true;
    },
    /** Removes the chat's loop (only `id` when given, so a newer one is never cleared by mistake). */
    clear(workspaceId, taskId, id = null) {
      const loop = loops[key(workspaceId, taskId)];
      if (!loop || (id && loop.id !== id)) return false;
      delete loops[key(workspaceId, taskId)];
      persist();
      return true;
    },
  };
}

module.exports = { MIN_LOOP_MINUTES, MAX_LOOP_MINUTES, LOOP_PROMPT_LIMIT, LOOP_LIFETIME_MS, cleanLoop, loopMessage, loopAction, createLoopStore };
