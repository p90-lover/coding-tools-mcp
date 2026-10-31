const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { codexThreadStats } = require("../electron/codex-thread-stats.cjs");

const THREAD = "01a175db-0000-4000-8000-000000000001";
const OTHER = "01a1905c-0000-4000-8000-000000000002";

// Test files stay in the repo's aiTemp, never the system temp folder on C: (AGENTS.md).
function codexHome(t) {
  const root = path.join(__dirname, "..", "..", "aiTemp", "codex-thread-stats-tests", crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a session's tokens, model, effort and times come from Codex's own thread index, read in a worker", async (t) => {
  const home = codexHome(t);
  const database = new DatabaseSync(path.join(home, "state_5.sqlite"));
  // An older index without the _ms columns or a name: times come from the second columns.
  database.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
    model TEXT, reasoning_effort TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run(THREAD, "Add WebGPT support", 454285827, "gpt-6.1-sol", "max", 1000, 2000);
  database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run(OTHER, "", 0, null, null, 3000, 4000);
  database.close();

  const stats = await codexThreadStats(home, [THREAD.toUpperCase(), OTHER, "not-a-thread", "../escape"]);
  assert.deepEqual(stats.get(THREAD), {
    title: "Add WebGPT support", tokensUsed: 454285827, model: "gpt-6.1-sol", effort: "max", createdAt: 1_000_000, updatedAt: 2_000_000,
  });
  assert.deepEqual(stats.get(OTHER), { title: null, tokensUsed: 0, model: null, effort: null, createdAt: 3_000_000, updatedAt: 4_000_000 });
  assert.equal(stats.size, 2, "ids that are not Codex thread ids are never asked for");
});

test("an index that cannot be read gives no numbers and a warning, never a throw", async (t) => {
  const warnings = [];
  const stats = await codexThreadStats(codexHome(t), [THREAD], { logger: { warn: (event) => warnings.push(event) } });
  assert.equal(stats.size, 0);
  assert.deepEqual(warnings, ["codex_thread_stats.unreadable"]);
});
