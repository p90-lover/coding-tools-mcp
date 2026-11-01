"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

/**
 * What Codex's own thread index (state_5.sqlite, read only) holds about some threads: title, tokens
 * used, model, effort and times. Read in a worker thread: a database read on a busy disk held the
 * main process (every window) for seconds, as the synchronous file reads it replaces did.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
let database;
try {
  const { DatabaseSync } = require("node:sqlite");
  database = new DatabaseSync(workerData.dbPath, { readOnly: true });
  const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
  const pick = (name, fallback = "NULL") => (columns.has(name) ? name : fallback);
  const query = database.prepare(
    "SELECT id, " + pick("name") + " AS name, " + pick("title") + " AS title, " + pick("tokens_used", "0") + " AS tokens,"
    + " " + pick("model") + " AS model, " + pick("reasoning_effort") + " AS effort,"
    + " " + pick("created_at_ms", "created_at * 1000") + " AS created, " + pick("updated_at_ms", "updated_at * 1000") + " AS updated"
    + " FROM threads WHERE id = ?",
  );
  const rows = [];
  for (const id of workerData.threadIds) {
    const row = query.get(id);
    if (row) rows.push(row);
  }
  parentPort.postMessage({ rows });
} catch (error) {
  parentPort.postMessage({ error: String((error && error.message) || error) });
} finally {
  try { database && database.close(); } catch {}
}
`;

const THREAD_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_THREADS = 200;
const TIMEOUT_MS = 15_000;

const number = (value) => (typeof value === "bigint" ? Number(value) : Number.isFinite(value) ? value : null);
const text = (value, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Map of thread id (lowercase) to { title, tokensUsed, model, effort, createdAt, updatedAt }; empty when unreadable. */
async function codexThreadStats(codexHome, threadIds, { logger, createWorker = (source, options) => new Worker(source, options) } = {}) {
  const ids = [...new Set([...threadIds].map((id) => String(id).toLowerCase()).filter((id) => THREAD_ID.test(id)))].slice(0, MAX_THREADS);
  const stats = new Map();
  if (!ids.length) return stats;
  const reply = await new Promise((resolve) => {
    let worker;
    try {
      worker = createWorker(WORKER_SOURCE, { eval: true, workerData: { dbPath: path.join(codexHome, "state_5.sqlite"), threadIds: ids } });
    } catch (error) {
      resolve({ error: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => { void worker.terminate(); resolve({ error: "timed out" }); }, TIMEOUT_MS);
    timer.unref?.();
    worker.once("message", (message) => { clearTimeout(timer); resolve(message); });
    worker.once("error", (error) => { clearTimeout(timer); resolve({ error: String(error?.message ?? error) }); });
    worker.once("exit", () => { clearTimeout(timer); resolve({ error: "worker exited" }); });
  });
  if (reply?.error) {
    logger?.warn?.("codex_thread_stats.unreadable", { message: reply.error.slice(0, 300) });
    return stats;
  }
  for (const row of reply?.rows ?? []) {
    stats.set(String(row.id).toLowerCase(), {
      title: text(row.name) ?? text(row.title),
      tokensUsed: number(row.tokens) ?? 0,
      model: text(row.model, 80),
      effort: text(row.effort, 40),
      createdAt: number(row.created),
      updatedAt: number(row.updated),
    });
  }
  return stats;
}

module.exports = { codexThreadStats };
