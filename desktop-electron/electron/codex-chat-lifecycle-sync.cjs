const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_[A-Za-z0-9_-]+)?\.jsonl(?:\.zst)?$/i;
const CHAT_URL = /^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9-]{8,})$/;
const CONVERSATION_KEY = /^[0-9a-f]{64}$/;
const DELETE_GRACE_MS = 60_000;
const SCAN_INTERVAL_MS = 20_000;

/** Missing rollout alone is not proof of a Codex Delete click (migration can move files). */
function codexThreadIndexState(codexHome, threadId) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) return "unavailable";
  let database;
  try {
    const { DatabaseSync } = require("node:sqlite");
    database = new DatabaseSync(dbPath, { readOnly: true });
    return database.prepare("SELECT id FROM threads WHERE id = ? LIMIT 1").get(threadId)
      ? "present" : "absent";
  } catch {
    // No destructive remote action when SQLite is locked, incompatible, or unavailable.
    return "unavailable";
  } finally {
    database?.close();
  }
}

/** Read only the two Codex rollout directories; no SQLite writes and no filesystem mutation. */
function codexRolloutLocations(codexHome, threadIds, io = fs) {
  const found = new Map();
  const visit = (root, archived) => {
    if (!io.existsSync(root)) return false;
    if (!io.lstatSync(root).isDirectory() || io.lstatSync(root).isSymbolicLink()) {
      throw new Error("Codex rollout root is not a regular directory");
    }
    let scanned = 0;
    const walk = (directory, depth) => {
      for (const entry of io.readdirSync(directory, { withFileTypes: true })) {
        if (++scanned > 100_000) throw new Error("Codex rollout scan exceeded the safe directory limit");
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && !archived && depth < 3 && /^\d+$/.test(entry.name)) {
          walk(path.join(directory, entry.name), depth + 1);
        } else if (entry.isFile()) {
          const match = ROLLOUT.exec(entry.name);
          if (match && threadIds.has(match[1].toLowerCase())) {
            const id = match[1].toLowerCase();
            if (!found.has(id) || !archived) found.set(id, archived ? "archived" : "active");
          }
        }
      }
    };
    walk(root, 0);
    return true;
  };
  const activeReady = visit(path.join(codexHome, "sessions"), false);
  const archivedReady = visit(path.join(codexHome, "archived_sessions"), true);
  return { ready: activeReady && archivedReady, found };
}

class CodexChatLifecycleSync {
  constructor({ filePath, codexHome, onSync, enabled, logger, io = fs, now = Date.now,
    indexedThread = codexThreadIndexState }) {
    this.filePath = filePath;
    this.codexHome = codexHome;
    this.onSync = onSync;
    this.enabled = enabled;
    this.logger = logger;
    this.io = io;
    this.now = now;
    this.indexedThread = indexedThread;
    this.entries = new Map();
    this.seenAlive = new Set();
    this.timer = null;
    this.polling = false;
    this.registryUnavailable = false;
    if (io.existsSync(filePath)) {
      try {
        const saved = JSON.parse(io.readFileSync(filePath, "utf8"));
        if (saved.version !== 1 || !Array.isArray(saved.entries)) {
          throw new Error("Codex ChatGPT lifecycle sync registry is invalid");
        }
        for (const item of saved.entries) {
          if (typeof item.threadId !== "string" || !THREAD_ID.test(item.threadId)
            || typeof item.conversationUrl !== "string" || !CHAT_URL.test(item.conversationUrl)
            || typeof item.remoteArchived !== "boolean" || item.remoteDeleted === true) continue;
          this.entries.set(`${item.threadId.toLowerCase()}|${item.conversationUrl}`, {
            threadId: item.threadId.toLowerCase(), conversationUrl: item.conversationUrl,
            remoteArchived: item.remoteArchived, remoteDeleted: false, everSeen: item.everSeen === true,
            ...(typeof item.conversationKey === "string" && CONVERSATION_KEY.test(item.conversationKey)
              ? { conversationKey: item.conversationKey } : {}),
            ...(typeof item.connectorIdentity === "string" && item.connectorIdentity.length > 0
              && item.connectorIdentity.length <= 128 ? { connectorIdentity: item.connectorIdentity } : {}),
          });
        }
      } catch (error) {
        // Preserve the original unreadable registry for recovery; never overwrite it.
        this.entries.clear();
        this.registryUnavailable = true;
        this.logger?.warn?.("browser.chat_lifecycle_registry_unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  save() {
    writePrivateFileAtomic(this.filePath, JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2) + "\n");
  }

  register(threadId, conversationUrl, conversationKey, connectorIdentity) {
    if (this.registryUnavailable) return false;
    if (typeof threadId !== "string" || !THREAD_ID.test(threadId)
      || typeof conversationUrl !== "string" || !CHAT_URL.test(conversationUrl)) return false;
    if (conversationKey !== undefined && (typeof conversationKey !== "string"
      || !CONVERSATION_KEY.test(conversationKey))) return false;
    if (connectorIdentity !== undefined && (typeof connectorIdentity !== "string"
      || !connectorIdentity || connectorIdentity.length > 128)) return false;
    const id = threadId.toLowerCase();
    const key = `${id}|${conversationUrl}`;
    const previous = this.entries.get(key);
    if (previous?.conversationUrl === conversationUrl) {
      if ((conversationKey && previous.conversationKey !== conversationKey)
        || (connectorIdentity && previous.connectorIdentity !== connectorIdentity)) {
        if (conversationKey) previous.conversationKey = conversationKey;
        if (connectorIdentity) previous.connectorIdentity = connectorIdentity;
        this.save();
      }
      return true;
    }
    // A native thread can own several ChatGPT epochs after automatic compaction.
    this.entries.set(key, { threadId: id, conversationUrl, remoteArchived: false,
      remoteDeleted: false, everSeen: false,
      ...(conversationKey ? { conversationKey } : {}),
      ...(connectorIdentity ? { connectorIdentity } : {}) });
    this.save();
    if (this.timer) queueMicrotask(() => { void this.poll(); });
    return true;
  }

  /** A saved URL is reusable only for the exact native thread and retained epoch.
   * Older registry entries have no epoch proof and must not be guessed into a live task.
   */
  findRetainedConversation(threadId, conversationKey, connectorIdentity) {
    if (this.registryUnavailable || typeof threadId !== "string" || !THREAD_ID.test(threadId)
      || typeof conversationKey !== "string" || !CONVERSATION_KEY.test(conversationKey)) return undefined;
    const matches = [...this.entries.values()].filter(entry => entry.threadId === threadId.toLowerCase()
      && entry.conversationKey === conversationKey
      && entry.connectorIdentity === connectorIdentity && entry.remoteDeleted !== true);
    return matches.length === 1 ? matches[0].conversationUrl : undefined;
  }

  async poll() {
    if (this.registryUnavailable || this.polling || this.entries.size === 0) return;
    this.polling = true;
    try {
      const { ready, found } = codexRolloutLocations(this.codexHome,
        new Set([...this.entries.values()].map(entry => entry.threadId)), this.io);
      if (!ready) return;
      for (const entry of this.entries.values()) {
        const location = found.get(entry.threadId);
        if (location) {
          this.seenAlive.add(entry.threadId);
          if (!entry.everSeen) {
            entry.everSeen = true;
            this.save();
          }
          entry.missingSince = undefined;
        } else if (!this.seenAlive.has(entry.threadId) && !entry.everSeen) {
          // A never-observed native session cannot authorize a remote deletion.
          continue;
        } else if (!entry.missingSince) {
          entry.missingSince = this.now();
          continue;
        }
        let action;
        if (location === "archived" && !entry.remoteArchived) action = "archive";
        else if (location === "active" && entry.remoteArchived) action = "unarchive";
        else if (!location && this.now() - entry.missingSince >= DELETE_GRACE_MS
          && this.indexedThread(this.codexHome, entry.threadId) === "absent") action = "delete";
        if (!action || !this.enabled(action)) continue;
        try {
          const synced = await this.onSync({ threadId: entry.threadId, conversationUrl: entry.conversationUrl, action });
          if (synced !== true) continue;
          if (action === "delete") {
            entry.remoteDeleted = true;
            this.entries.delete(`${entry.threadId}|${entry.conversationUrl}`);
          } else {
            entry.remoteArchived = action === "archive";
          }
          this.save();
          this.logger?.info?.("browser.chat_lifecycle_synced", { action, threadId: entry.threadId });
        } catch (error) {
          this.logger?.warn?.("browser.chat_lifecycle_sync_failed", {
            action, threadId: entry.threadId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger?.warn?.("browser.chat_lifecycle_scan_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, SCAN_INTERVAL_MS);
    this.timer.unref?.();
    void this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { CodexChatLifecycleSync, codexRolloutLocations, codexThreadIndexState, CHAT_URL };
