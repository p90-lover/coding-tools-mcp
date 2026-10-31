"use strict";

// Each chat's queued messages, kept by the app rather than by the chat view. A message typed while
// the agent works waits here and goes in as the chat's next turn once the turn settles; one typed in
// steer mode is steered in as soon as the agent can take it. Before, the queue lived in the chat
// view's memory: it was sent only while that very chat was open and the window had focus, so a
// follow-up queued before switching to another chat (or app) never went, and an app restart lost it.
//
// A steer that reached a turn which then died unread (its agent never answered, or never started)
// comes back here too, at the front, so it is sent as the next turn instead of disappearing.

const { createStateFileWriter, readStateFile } = require("./durable-state.cjs");

const MESSAGE_LIMIT = 8192;
const QUEUE_LIMIT = 50;
const STATE_VERSION = 1;
// Steers handed to a running turn, remembered until that turn shows whether its agent read them.
const DELIVERED_LIMIT = 20;

const TOOL_KINDS = new Set(["tool", "command", "edit"]);
const MODEL_OUTPUT_KINDS = new Set(["message", "reasoning", ...TOOL_KINDS]);

function text(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

/** A queued item as saved: the message, a /goal's condition, how it was typed, and how it runs. */
function cleanItem(item, makeId, at) {
  if (!item || typeof item !== "object") return null;
  const message = text(item.message, MESSAGE_LIMIT);
  if (!message.trim()) return null;
  const goal = text(item.goal, MESSAGE_LIMIT).trim();
  const typed = text(item.typed, MESSAGE_LIMIT);
  const what = text(item.what, 32).trim() || (goal ? "Goal" : "Message");
  const selection = item.selection && typeof item.selection === "object" && !Array.isArray(item.selection) ? item.selection : null;
  return {
    id: text(item.id, 80) || makeId(),
    what, message, at: Number.isFinite(item.at) ? item.at : at,
    ...(goal ? { goal } : {}), ...(typed ? { typed } : {}),
    ...(item.steer === true ? { steer: true } : {}),
    ...(selection ? { selection } : {}),
    ...(typeof item.executable === "string" && item.executable ? { executable: item.executable.slice(0, 1024) } : {}),
    ...(typeof item.note === "string" && item.note ? { note: item.note.slice(0, 300) } : {}),
  };
}

/**
 * Whether the agent read a steer in `timeline` (the turn's items, oldest first), the way the chat's
 * read receipt decides it (ao-chat.ts steerRead): the model went on past it. A steer that arrived
 * while the model waited on a tool call is read by its next output; otherwise the next request after
 * a tool call has it. Null when the timeline does not hold the steer at all.
 */
function steerReadIn(timeline, message) {
  const items = Array.isArray(timeline) ? timeline : [];
  // The timeline keeps a steer's first 400 bytes only: a long one is matched by its beginning.
  const head = (value) => String(value ?? "").trim().slice(0, 200);
  const wanted = head(message);
  const at = items.findLastIndex(item => item?.kind === "steer" && head(item.text) === wanted);
  if (at < 0) return null;
  let boundary = false;
  for (let index = at - 1; index >= 0; index -= 1) {
    if (!MODEL_OUTPUT_KINDS.has(items[index]?.kind)) continue;
    boundary = TOOL_KINDS.has(items[index].kind);
    break;
  }
  for (const item of items.slice(at + 1)) {
    if (boundary && MODEL_OUTPUT_KINDS.has(item?.kind)) return true;
    if (TOOL_KINDS.has(item?.kind)) boundary = true;
  }
  return false;
}

/**
 * The chats' queues, saved in a small JSON file with a copy (durable-state.cjs), so they survive an
 * app restart and a torn file. Without a file (tests) they live in memory.
 */
function createChatQueueStore({ file = null, now = Date.now, logger = null } = {}) {
  let chats = {};
  if (file) {
    const read = readStateFile(file, (raw) => {
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || typeof saved.chats !== "object" || Array.isArray(saved.chats)) throw new Error("not a chat queue file");
      return saved.chats;
    }, { now });
    if (read.value) chats = read.value;
    if (read.source === "backup" || read.source === "unreadable") {
      logger?.warn?.(read.source === "backup" ? "chat_queue.restored_from_copy" : "chat_queue.unreadable", { message: String(read.error?.message || "").slice(0, 200) });
    }
  }
  let counter = 0;
  const makeId = () => `queued-${now().toString(36)}-${(counter += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  const writer = file ? createStateFileWriter(file, { protectDirectory: false,
    onError: (error) => logger?.warn?.("chat_queue.save_failed", { message: String(error?.message || error).slice(0, 200) }) }) : null;
  const persist = () => writer?.save(`${JSON.stringify({ version: STATE_VERSION, chats })}\n`);
  const chat = (workspaceId, taskId) => chats[key(workspaceId, taskId)];
  const items = (workspaceId, taskId) => (Array.isArray(chat(workspaceId, taskId)?.items) ? chat(workspaceId, taskId).items : []);
  const delivered = (workspaceId, taskId) => (Array.isArray(chat(workspaceId, taskId)?.delivered) ? chat(workspaceId, taskId).delivered : []);
  const save = (workspaceId, taskId, change) => {
    const next = { workspaceId, taskId, items: items(workspaceId, taskId), delivered: delivered(workspaceId, taskId), ...change };
    if (!next.items.length && !next.delivered.length) delete chats[key(workspaceId, taskId)];
    else chats[key(workspaceId, taskId)] = next;
    persist();
  };
  return {
    /** Resolves once every change so far is on disk (tests, and a caller about to exit). */
    saved: async () => writer?.saved(),
    list: (workspaceId, taskId) => items(workspaceId, taskId).map(item => ({ ...item })),
    /** Every chat's queue in one project, by task (what the chat view shows). */
    forWorkspace(workspaceId) {
      const prefix = `${workspaceId}:`;
      return Object.fromEntries(Object.entries(chats).filter(([name, entry]) => name.startsWith(prefix) && entry.items?.length)
        .map(([name, entry]) => [name.slice(prefix.length), entry.items.map(item => ({ ...item }))]));
    },
    /** Every chat with something queued, for draining them when the app starts. */
    chats: () => Object.values(chats).filter(entry => entry.items?.length).map(entry => ({ workspaceId: entry.workspaceId, taskId: entry.taskId })),
    /** Adds `item` at the end, or at the front with `front`; returns the saved item. */
    add(workspaceId, taskId, item, { front = false } = {}) {
      const clean = cleanItem(item, makeId, now());
      if (!clean) throw new Error("Type a message to queue");
      const current = items(workspaceId, taskId).filter(entry => entry.id !== clean.id);
      if (current.length >= QUEUE_LIMIT) throw new Error(`A chat can queue at most ${QUEUE_LIMIT} messages`);
      save(workspaceId, taskId, { items: front ? [clean, ...current] : [...current, clean] });
      return { ...clean };
    },
    /** Removes the items `ids` (all of them when `ids` is null); returns how many went. */
    remove(workspaceId, taskId, ids = null) {
      const current = items(workspaceId, taskId);
      const keep = ids === null ? [] : current.filter(entry => !ids.includes(entry.id));
      if (keep.length !== current.length) save(workspaceId, taskId, { items: keep });
      return current.length - keep.length;
    },
    update(workspaceId, taskId, id, change) {
      const current = items(workspaceId, taskId);
      if (!current.some(entry => entry.id === id)) return null;
      const next = current.map(entry => (entry.id === id ? { ...entry, ...change } : entry));
      save(workspaceId, taskId, { items: next });
      return { ...next.find(entry => entry.id === id) };
    },
    /** A steer handed to run `runId`'s turn: kept until that turn shows whether it was read. */
    delivered(workspaceId, taskId, steer) {
      const entry = { id: makeId(), message: text(steer.message, MESSAGE_LIMIT), runId: text(steer.runId, 80), at: now(),
        ...(steer.goal ? { goal: text(steer.goal, MESSAGE_LIMIT) } : {}),
        ...(steer.selection ? { selection: steer.selection } : {}) };
      save(workspaceId, taskId, { delivered: [...delivered(workspaceId, taskId), entry].slice(-DELIVERED_LIMIT) });
      return entry;
    },
    /** The steers handed to run `runId`, every chat of the project. */
    deliveredTo(workspaceId, runId) {
      const prefix = `${workspaceId}:`;
      return Object.entries(chats).filter(([name]) => name.startsWith(prefix))
        .flatMap(([, entry]) => (entry.delivered ?? []).filter(steer => steer.runId === runId).map(steer => ({ ...steer, taskId: entry.taskId })));
    },
    forgetDelivered(workspaceId, taskId, ids) {
      const current = delivered(workspaceId, taskId);
      const keep = current.filter(entry => !ids.includes(entry.id));
      if (keep.length !== current.length) save(workspaceId, taskId, { delivered: keep });
    },
  };
}

module.exports = { MESSAGE_LIMIT, QUEUE_LIMIT, createChatQueueStore, steerReadIn };
