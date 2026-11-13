"use strict";

// Deleting one message from a chat. A chat is a board task whose description holds the user's
// messages (the first one, then "\n\nFollow-up (<stamp> UTC):\n<text>" blocks, each with any
// "\n\n↳ Steer (<stamp> UTC): <text>" lines sent during its turn), and each message started one run.
// The chat pairs the runs with the messages in order (a restart answers its run's message again),
// so a deleted message takes its runs out of the chat too: they are kept in AO's history but left
// out of what the chat is shown. The agent's session still remembers the deleted exchange, so the
// chat's next follow-up starts a fresh session.

const fs = require("node:fs");
const { writePrivateFileAtomicAsync } = require("./atomic-file.cjs");

// The same follow-up marker ao-chat.ts (chatMessagesFromDescription) reads.
const FOLLOW_UP = /\n\nFollow-up \(([^)]+) UTC\):\n/;

/**
 * The description without the user's message at `index` (and the steers sent during its turn);
 * every other message keeps its exact text. Deleting the first message makes the next one first.
 */
function chatDescriptionWithout(description, index) {
  const parts = String(description ?? "").split(FOLLOW_UP);
  // Messages in order: the head (when it has text), then each follow-up as [stamp, body].
  const head = parts[0];
  const followUps = [];
  for (let at = 1; at < parts.length; at += 2) followUps.push({ stamp: parts[at], body: parts[at + 1] ?? "" });
  const hasHead = Boolean(head.trim());
  const count = followUps.length + (hasHead ? 1 : 0);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("That message is no longer in this chat; refresh it");
  if (count === 1) throw new Error("This is the chat's only message; archive or delete the chat instead");
  const block = (message) => `\n\nFollow-up (${message.stamp} UTC):\n${message.body}`;
  if (hasHead && index === 0) {
    const [next, ...rest] = followUps;
    return next.body + rest.map(block).join("");
  }
  const dropped = index - (hasHead ? 1 : 0);
  return head + followUps.filter((_, at) => at !== dropped).map(block).join("");
}

/** How many user messages the description holds (the head when it has text, then each follow-up). */
function chatMessageCount(description) {
  const parts = String(description ?? "").split(FOLLOW_UP);
  return (parts.length - 1) / 2 + (parts[0].trim() ? 1 : 0);
}

/**
 * The description with a steer line added to message number `messages` (1-based), the one whose
 * turn it was sent in. A team run's note waits for the run to settle, and the next message could
 * be saved first: appended at the end, the steer then sat under that newer message, and the chat
 * moved it from where it was sent down into the new turn. Unknown or the last message: the end.
 */
function chatDescriptionWithSteer(description, messages, steer) {
  const text = String(description ?? "");
  const hasHead = Boolean(text.split(FOLLOW_UP)[0].trim());
  const followUps = [...text.matchAll(new RegExp(FOLLOW_UP.source, "g"))];
  // The follow-up that starts the message after it: the steer goes in just before that one.
  const next = followUps[Number.isSafeInteger(messages) && messages >= 1 ? messages - (hasHead ? 1 : 0) : -1];
  if (!next) return `${text}\n\n${steer}`.trim();
  return `${text.slice(0, next.index)}\n\n${steer}${text.slice(next.index)}`;
}

/**
 * Per chat ("<workspace>:<task>"): the runs of deleted messages, hidden from the chat; whether the
 * next follow-up must start a fresh agent session; which runs restart an earlier one (Restart
 * mission adds a run without a message, so the chat must not pair it with the next message); and
 * the window each agent session was resized to after it started (chat_context_window). Kept
 * in a small JSON file so all of it survives an app restart; without a file (tests) it lives in memory.
 *
 * A change is in memory at once and saved off the main thread: the synchronous save held every
 * window 470 ms on the hard disk when a follow-up cleared `fresh` (launcher.main_blocked
 * writeFileSync chat-edits.json < clearFresh < startChatSend, 2026-11-12). Each change returns its
 * save, so a delete that must not stand unsaved waits for it and fails with it; saves land in order.
 */
function createChatEditStore({ file = null, logger = null } = {}) {
  let chats = {};
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) chats = saved;
    } catch { /* Nothing deleted yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  let lastSave = Promise.resolve();
  /** Saves every chat as it is now: resolves once that is on disk, rejects when it could not be. */
  const persist = () => {
    if (!file) return Promise.resolve();
    const save = writePrivateFileAtomicAsync(file, JSON.stringify(chats, null, 2), { durable: true, protectDirectory: false });
    // A caller that does not wait keeps its change in memory, and the next change saves it again.
    save.catch((error) => logger?.warn?.("chat_edits.not_saved", { message: String(error?.message ?? error).slice(0, 200) }));
    lastSave = save;
    return save;
  };
  const projectChats = (workspaceId) => {
    const prefix = `${workspaceId}:`;
    return Object.entries(chats).filter(([name]) => name.startsWith(prefix)).map(([, chat]) => chat);
  };
  return {
    /** Resolves once every change so far is on disk, or has failed to get there (a caller about to exit, tests). */
    saved: () => lastSave.then(() => {}, () => {}),
    get: (workspaceId, taskId) => chats[key(workspaceId, taskId)] ?? null,
    /** A message was deleted: hide its runs (the one it started and any restarts of it) and start the next follow-up afresh. */
    deleteMessage(workspaceId, taskId, runIds) {
      const chat = chats[key(workspaceId, taskId)] ?? { deletedRuns: [] };
      chats[key(workspaceId, taskId)] = { ...chat, deletedRuns: [...new Set([...(chat.deletedRuns ?? []), ...runIds.filter(Boolean)])], fresh: true };
      return persist();
    },
    /** Restart mission: `runId` is a fresh run of the same message as `previousRunId`. */
    restarted(workspaceId, taskId, previousRunId, runId) {
      const chat = chats[key(workspaceId, taskId)] ?? {};
      chats[key(workspaceId, taskId)] = { ...chat, restarts: { ...(chat.restarts ?? {}), [runId]: previousRunId } };
      return persist();
    },
    /** Every run of one message: the run it started, then each restart of it (and of those). */
    runsOfMessage(workspaceId, taskId, runId) {
      const restarts = Object.entries(chats[key(workspaceId, taskId)]?.restarts ?? {});
      const found = [runId];
      for (let at = 0; at < found.length; at += 1) {
        for (const [next, previous] of restarts) if (previous === found[at] && !found.includes(next)) found.push(next);
      }
      return found;
    },
    /** Puts a chat's entry back as it was (a failed delete). */
    restore(workspaceId, taskId, saved) {
      if (saved) chats[key(workspaceId, taskId)] = saved; else delete chats[key(workspaceId, taskId)];
      return persist();
    },
    /**
     * The chat's agent `session` was resized in place to the card's `contextWindow` (a route value:
     * tokens, or null for the model's default). Its card still says the window it started with, so
     * the next follow-up reads this one instead and continues the agent rather than starting afresh.
     */
    resized(workspaceId, taskId, session, contextWindow) {
      const chat = chats[key(workspaceId, taskId)] ?? {};
      chats[key(workspaceId, taskId)] = { ...chat, windows: { ...(chat.windows ?? {}), [session]: contextWindow ?? null } };
      persist();
    },
    /** The window `session` was resized to (null: the model's default), or undefined when it never was. */
    resizedWindow: (workspaceId, taskId, session) => {
      const windows = chats[key(workspaceId, taskId)]?.windows;
      return windows && Object.hasOwn(windows, session) ? windows[session] : undefined;
    },
    /** Whether the chat's next follow-up must start a fresh session. */
    fresh: (workspaceId, taskId) => chats[key(workspaceId, taskId)]?.fresh === true,
    clearFresh(workspaceId, taskId) {
      const chat = chats[key(workspaceId, taskId)];
      if (!chat?.fresh) return Promise.resolve();
      chats[key(workspaceId, taskId)] = { ...chat, fresh: false };
      return persist();
    },
    /**
     * The runs a chat shows: those of deleted messages are left out, and a restart says which run it
     * restarts (`restarts_run_id`), so the chat shows it under that message instead of the next one.
     */
    visible(workspaceId, runs) {
      const project = projectChats(workspaceId);
      const deleted = new Set(project.flatMap(chat => chat.deletedRuns ?? []));
      const restarts = Object.assign({}, ...project.map(chat => chat.restarts ?? {}));
      if (!deleted.size && !Object.keys(restarts).length) return runs;
      return runs.filter(run => !deleted.has(run?.id))
        .map(run => restarts[run?.id] && !run.restarts_run_id ? { ...run, restarts_run_id: restarts[run.id] } : run);
    },
  };
}

module.exports = { chatDescriptionWithout, chatDescriptionWithSteer, chatMessageCount, createChatEditStore };
