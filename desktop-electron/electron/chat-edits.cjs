"use strict";

// Deleting one message from a chat. A chat is a board task whose description holds the user's
// messages (the first one, then "\n\nFollow-up (<stamp> UTC):\n<text>" blocks, each with any
// "\n\n↳ Steer (<stamp> UTC): <text>" lines sent during its turn), and each message started one run.
// The chat pairs the runs with the messages in order (a restart answers its run's message again),
// so a deleted message takes its runs out of the chat too: they are kept in AO's history but left
// out of what the chat is shown. The agent's session still remembers the deleted exchange, so the
// chat's next follow-up starts a fresh session.

const { readStateFile, writeStateFileAsync } = require("./durable-state.cjs");

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
 * next follow-up must start a fresh agent session; and which runs restart an earlier one (Restart
 * mission adds a run without a message, so the chat must not pair it with the next message). Kept
 * in a small JSON file so all of it survives an app restart; without a file (tests) it lives in memory.
 */
function createChatEditStore({ file = null, logger = null } = {}) {
  let chats = {};
  if (file) {
    // Read once, when the workflow is created; a torn file falls back to its backup copy.
    const read = readStateFile(file, (raw) => {
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("not a chat edits file");
      return saved;
    });
    if (read.value) chats = read.value;
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  // Saved on a pool thread (writeStateFileAsync). Written and renamed on the main thread, a save
  // held every window: renameSync took 496 ms during a chat send on the busy disk (2026-11-13
  // 00:24Z). What the app reads is `chats` in memory, changed at once; the file carries it across
  // a restart. Each change returns its own save, which rejects when it failed: a delete is saved
  // before the chat's record changes and is refused, and put back, when it can't be. A failure is
  // logged too, so a caller that doesn't wait (a restart mark) never leaves it unhandled.
  let lastSave = Promise.resolve();
  const persist = () => {
    if (!file) return Promise.resolve();
    const saving = writeStateFileAsync(file, JSON.stringify(chats, null, 2), { protectDirectory: false });
    saving.catch((error) => logger?.warn?.("chat_edits.save_failed", { message: String(error?.message || error).slice(0, 200) }));
    lastSave = saving.catch(() => undefined);
    return saving;
  };
  const projectChats = (workspaceId) => {
    const prefix = `${workspaceId}:`;
    return Object.entries(chats).filter(([name]) => name.startsWith(prefix)).map(([, chat]) => chat);
  };
  return {
    /** Resolves once every change made so far is saved, or failed to be. */
    saved: async () => { await lastSave; },
    get: (workspaceId, taskId) => chats[key(workspaceId, taskId)] ?? null,
    /**
     * A message was deleted: hide its runs (the one it started and any restarts of it) and start the
     * next follow-up afresh. Returns the save, which rejects when it failed (see persist).
     */
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
    /** Puts a chat's entry back as it was (a failed delete). Returns the save, as deleteMessage does. */
    restore(workspaceId, taskId, saved) {
      if (saved) chats[key(workspaceId, taskId)] = saved; else delete chats[key(workspaceId, taskId)];
      return persist();
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
