"use strict";

const CONVERSATION_ID = /^[0-9a-f-]{36}$/;
const CHAT_URL = /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})$/;
// What ChatGPT's own Archive, Unarchive and Delete menu items send for a conversation.
const PATCHES = Object.freeze({
  archive: { is_archived: true },
  unarchive: { is_archived: false },
  delete: { is_visible: false },
});
// A same-origin page that is tiny and never runs ChatGPT's app: enough for the requests to carry
// the account's cookies, without loading a whole chat page per action.
const ACTION_PAGE_URL = "https://chatgpt.com/robots.txt";
const ACTION_TIMEOUT_MS = 30_000;

/**
 * Runs one conversation action from inside a chatgpt.com page. The page's session token is read
 * and used in the page and never returned. A deleted conversation that is already gone (404) counts
 * as deleted.
 */
function conversationPatchScript(conversationId, action) {
  if (!CONVERSATION_ID.test(conversationId)) throw new Error("Not a ChatGPT conversation id");
  const patch = PATCHES[action];
  if (!patch) throw new Error(`Unknown ChatGPT conversation action: ${action}`);
  return `(async (id, patch, gone) => {
    const session = await fetch("/api/auth/session", { credentials: "include" }).then((r) => r.ok ? r.json() : null).catch(() => null);
    const token = session && typeof session.accessToken === "string" ? session.accessToken : "";
    if (!token) return { ok: false, reason: "no ChatGPT session" };
    const response = await fetch("/backend-api/conversation/" + id, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify(patch),
    });
    return { ok: response.ok || (gone && response.status === 404), status: response.status };
  })(${JSON.stringify(conversationId)}, ${JSON.stringify(patch)}, ${action === "delete"})`;
}

const withTimeout = (promise, ms, what) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Archives, unarchives or deletes a saved ChatGPT conversation on a given account, whether or not
 * that account is the one the Browser tab shows: each action runs in a hidden page of the account's
 * own partition, one at a time.
 */
function createConversationActions({ createContents, timeoutMs = ACTION_TIMEOUT_MS, logger = null }) {
  let queue = Promise.resolve();

  async function runNow(partition, conversationUrl, action) {
    const id = CHAT_URL.exec(String(conversationUrl ?? ""))?.[1];
    if (!id) throw new Error("Not a saved ChatGPT conversation URL");
    const script = conversationPatchScript(id, action);
    const contents = createContents(partition);
    try {
      await withTimeout(contents.loadURL(ACTION_PAGE_URL), timeoutMs, "Opening chatgpt.com");
      const result = await withTimeout(contents.executeJavaScript(script, true), timeoutMs, `ChatGPT ${action}`);
      if (!result?.ok) throw new Error(result?.reason || `ChatGPT refused to ${action} the conversation (HTTP ${result?.status})`);
      logger?.info?.("browser.conversation_action", { action, status: result.status });
      return true;
    } finally {
      if (!contents.isDestroyed()) contents.close();
    }
  }

  return {
    run(partition, conversationUrl, action) {
      const next = queue.then(() => runNow(partition, conversationUrl, action));
      queue = next.catch(() => {});
      return next;
    },
  };
}

module.exports = { ACTION_PAGE_URL, CHAT_URL, PATCHES, conversationPatchScript, createConversationActions };
