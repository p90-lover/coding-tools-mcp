"use strict";

// Deleting one message from a chat. A chat is a board task whose description holds the user's
// messages (the first one, then "\n\nFollow-up (<stamp> UTC):\n<text>" blocks, each with any
// "\n\n↳ Steer (<stamp> UTC): <text>" lines sent during its turn), and each message started one run.
// The chat pairs the runs with the messages in order (a restart answers its run's message again),
// so a deleted message takes its runs out of the chat too: they are kept in AO's history but left
// out of what the chat is shown. The agent's session still remembers the deleted exchange, so the
// chat's next follow-up starts a fresh session.

const fs = require("node:fs");
const path = require("node:path");

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

/**
 * Per chat ("<workspace>:<task>"): the runs of deleted messages, hidden from the chat; whether the
 * next follow-up must start a fresh agent session; and which runs restart an earlier one (Restart
 * mission adds a run without a message, so the chat must not pair it with the next message). Kept
 * in a small JSON file so all of it survives an app restart; without a file (tests) it lives in memory.
 */
function createChatEditStore({ file = null } = {}) {
  let chats = {};
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) chats = saved;
    } catch { /* Nothing deleted yet. */ }
  }
  const key = (workspaceId, taskId) => `${workspaceId}:${taskId}`;
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(chats, null, 2));
    fs.renameSync(temporary, file);
  };
  const projectChats = (workspaceId) => {
    const prefix = `${workspaceId}:`;
    return Object.entries(chats).filter(([name]) => name.startsWith(prefix)).map(([, chat]) => chat);
  };
  return {
    get: (workspaceId, taskId) => chats[key(workspaceId, taskId)] ?? null,
    /** A message was deleted: hide its runs (the one it started and any restarts of it) and start the next follow-up afresh. */
    deleteMessage(workspaceId, taskId, runIds) {
      const chat = chats[key(workspaceId, taskId)] ?? { deletedRuns: [] };
      chats[key(workspaceId, taskId)] = { ...chat, deletedRuns: [...new Set([...(chat.deletedRuns ?? []), ...runIds.filter(Boolean)])], fresh: true };
      persist();
    },
    /** Restart mission: `runId` is a fresh run of the same message as `previousRunId`. */
    restarted(workspaceId, taskId, previousRunId, runId) {
      const chat = chats[key(workspaceId, taskId)] ?? {};
      chats[key(workspaceId, taskId)] = { ...chat, restarts: { ...(chat.restarts ?? {}), [runId]: previousRunId } };
      persist();
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
      persist();
    },
    /** Whether the chat's next follow-up must start a fresh session. */
    fresh: (workspaceId, taskId) => chats[key(workspaceId, taskId)]?.fresh === true,
    clearFresh(workspaceId, taskId) {
      const chat = chats[key(workspaceId, taskId)];
      if (!chat?.fresh) return;
      chats[key(workspaceId, taskId)] = { ...chat, fresh: false };
      persist();
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

module.exports = { chatDescriptionWithout, createChatEditStore };
