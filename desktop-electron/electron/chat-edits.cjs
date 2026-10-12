"use strict";

// Deleting one message from a chat. A chat is a board task whose description holds the user's
// messages (the first one, then "\n\nFollow-up (<stamp> UTC):\n<text>" blocks, each with any
// "\n\n↳ Steer (<stamp> UTC): <text>" lines sent during its turn), and each message started one run.
// The chat pairs run i with message i, so a deleted message takes its run out of the chat too: the
// run is kept in AO's history but left out of what the chat is shown. The agent's session still
// remembers the deleted exchange, so the chat's next follow-up starts a fresh session.

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
 * Per chat ("<workspace>:<task>"): the runs of deleted messages, hidden from the chat, and whether
 * the next follow-up must start a fresh agent session. Kept in a small JSON file so both survive an
 * app restart; without a file (tests) they live in memory.
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
  const deletedIn = (workspaceId) => {
    const prefix = `${workspaceId}:`;
    return new Set(Object.entries(chats).filter(([name]) => name.startsWith(prefix)).flatMap(([, chat]) => chat.deletedRuns ?? []));
  };
  return {
    get: (workspaceId, taskId) => chats[key(workspaceId, taskId)] ?? null,
    /** A message was deleted: hide its run (if it had one) and start the next follow-up afresh. */
    deleteMessage(workspaceId, taskId, runId) {
      const chat = chats[key(workspaceId, taskId)] ?? { deletedRuns: [] };
      chats[key(workspaceId, taskId)] = { ...chat, deletedRuns: [...new Set([...(chat.deletedRuns ?? []), ...(runId ? [runId] : [])])], fresh: true };
      persist();
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
    /** The runs a chat shows: those of deleted messages are left out. */
    visible(workspaceId, runs) {
      const deleted = deletedIn(workspaceId);
      return deleted.size ? runs.filter(run => !deleted.has(run?.id)) : runs;
    },
  };
}

module.exports = { chatDescriptionWithout, createChatEditStore };
