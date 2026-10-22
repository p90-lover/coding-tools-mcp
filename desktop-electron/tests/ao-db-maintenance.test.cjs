"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { compactAoDatabase } = require("../electron/ao-db-maintenance.cjs");

const MB = 1024 * 1024;
const small = { minFreeBytes: 1 * MB, minFreeRatio: 0.5, incrementalMinBytes: 1 * MB, maxUsedBytes: 512 * MB };
const pragma = (db, name) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get())[0]);

/** A WAL database like AO's: rows in a table with an implicit rowid, most of them then deleted. */
function mostlyEmpty() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-db-maint-"));
  const db = new DatabaseSync(path.join(dir, "ao.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE events (kind TEXT, body BLOB); CREATE TABLE turns (id INTEGER PRIMARY KEY, note TEXT)");
  const insert = db.prepare("INSERT INTO events (kind, body) VALUES (?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) insert.run(i % 10 === 0 ? "keep" : "chunk", Buffer.alloc(8 * 1024, i % 256));
  db.exec("COMMIT; INSERT INTO turns (note) VALUES ('first'), ('second'); DELETE FROM events WHERE kind = 'chunk'; PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return { dir, file: path.join(dir, "ao.db"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a mostly empty database is rewritten once, keeps its rows and their order, then frees pages incrementally", async () => {
  const fixture = mostlyEmpty();
  try {
    const before = fs.statSync(fixture.file).size;
    const result = await compactAoDatabase(fixture.dir, small);
    assert.equal(result.action, "vacuum", JSON.stringify(result));
    assert.ok(result.afterBytes < before / 3, `shrank from ${before} to ${result.afterBytes}`);
    let db = new DatabaseSync(fixture.file);
    assert.equal(pragma(db, "auto_vacuum"), 2, "switched to incremental auto-vacuum");
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get().n, 200, "every kept row is still there");
    const kinds = db.prepare("SELECT rowid, kind FROM events ORDER BY rowid").all();
    assert.ok(kinds.every((row, index) => index === 0 || row.rowid > kinds[index - 1].rowid), "rowid order is kept");
    assert.deepEqual(db.prepare("SELECT note FROM turns ORDER BY id").all().map((row) => row.note), ["first", "second"]);
    // More deletes later: a start gives that space back without a full rewrite.
    db.exec("DELETE FROM events WHERE rowid % 2 = 0; INSERT INTO events (kind, body) SELECT 'chunk', zeroblob(2000000) FROM (SELECT 1); DELETE FROM events WHERE kind = 'chunk'");
    db.close();
    const grown = fs.statSync(fixture.file).size;
    const again = await compactAoDatabase(fixture.dir, { ...small, incrementalMinBytes: 1 });
    assert.equal(again.action, "incremental", JSON.stringify(again));
    assert.ok(again.afterBytes <= grown);
    db = new DatabaseSync(fixture.file);
    assert.equal(pragma(db, "freelist_count"), 0, "no free pages left");
    db.close();
  } finally { fixture.cleanup(); }
});

test("a compaction that never finishes is stopped at its limit, so AO still starts", async () => {
  // Seen 2026-10-22: after an update AO stayed "starting" for over 10 minutes, waiting on this.
  const fixture = mostlyEmpty();
  try {
    const started = Date.now();
    const result = await compactAoDatabase(fixture.dir, { ...small, timeoutMs: 300,
      scriptSource: "setInterval(() => {}, 1000);" });
    assert.equal(result.action, "failed");
    assert.match(result.error, /timed out after 0 s; AO starts without it/);
    assert.ok(Date.now() - started < 5_000, "it does not wait past the limit");
    // The database is untouched and usable.
    const db = new DatabaseSync(fixture.file);
    assert.equal(db.prepare("SELECT count(*) AS n FROM turns").get().n, 2);
    db.close();
  } finally { fixture.cleanup(); }
});

test("a compaction stopped mid-write lets go of the database before AO starts", async () => {
  // Review on #484: a worker thread could not be stopped inside a native SQLite call, so after the
  // timeout it still held the write lock and AO started against a locked database. The maintenance
  // here takes the write lock and never lets go; once it is stopped, a new writer must get in.
  const fixture = mostlyEmpty();
  try {
    const holdsTheLock = `
      const { DatabaseSync } = require("node:sqlite");
      const { file } = JSON.parse(process.env.AO_DB_MAINTENANCE_INPUT);
      const db = new DatabaseSync(file);
      db.exec("BEGIN IMMEDIATE; INSERT INTO turns (note) VALUES ('unfinished')");
      for (;;) {}`;
    const result = await compactAoDatabase(fixture.dir, { ...small, timeoutMs: 1_500, scriptSource: holdsTheLock });
    assert.equal(result.action, "failed");
    assert.match(result.error, /timed out/);
    const db = new DatabaseSync(fixture.file, { timeout: 500 });
    db.exec("BEGIN IMMEDIATE; INSERT INTO turns (note) VALUES ('ao')");
    db.exec("COMMIT");
    assert.deepEqual(db.prepare("SELECT note FROM turns ORDER BY id").all().map((row) => row.note), ["first", "second", "ao"],
      "the stopped write was never committed, and AO's write goes through");
    db.close();
  } finally { fixture.cleanup(); }
});

test("one start gives back at most incrementalMaxBytes; the rest comes back over the next starts", async () => {
  // Seen live: an uncapped incremental_vacuum moved 443 MB through the WAL on a busy hard disk, and
  // AO, which waits for it, stayed down for over ten minutes.
  const fixture = mostlyEmpty();
  try {
    assert.equal((await compactAoDatabase(fixture.dir, small)).action, "vacuum");
    let db = new DatabaseSync(fixture.file);
    db.exec("DELETE FROM events WHERE rowid % 2 = 0; INSERT INTO events (kind, body) SELECT 'chunk', zeroblob(2000000) FROM (SELECT 1); DELETE FROM events WHERE kind = 'chunk'");
    const pageSize = pragma(db, "page_size");
    const freeBefore = pragma(db, "freelist_count");
    db.close();
    const cap = 16 * pageSize;
    assert.ok(freeBefore > 32, `enough free pages to need two starts: ${freeBefore}`);
    const first = await compactAoDatabase(fixture.dir, { ...small, incrementalMinBytes: 1, incrementalMaxBytes: cap });
    assert.equal(first.action, "incremental", JSON.stringify(first));
    db = new DatabaseSync(fixture.file);
    const freeAfter = pragma(db, "freelist_count");
    db.close();
    assert.equal(freeBefore - freeAfter, 16, "exactly the capped number of pages was given back");
    await compactAoDatabase(fixture.dir, { ...small, incrementalMinBytes: 1, incrementalMaxBytes: cap });
    db = new DatabaseSync(fixture.file);
    assert.equal(pragma(db, "freelist_count"), freeAfter - 16, "the next start gives back the next part");
    db.close();
  } finally { fixture.cleanup(); }
});

test("a database with little free space, none at all, or held by another connection is left alone", async () => {
  const fixture = mostlyEmpty();
  try {
    // Below the thresholds: nothing is done.
    assert.equal((await compactAoDatabase(fixture.dir, { ...small, minFreeBytes: 1024 * MB })).action, "none");
    // Another connection holding the write lock: the maintenance gives up without waiting long.
    const holder = new DatabaseSync(fixture.file);
    holder.exec("BEGIN IMMEDIATE; INSERT INTO turns (note) VALUES ('held')");
    const started = Date.now();
    const busy = await compactAoDatabase(fixture.dir, small);
    assert.equal(busy.action, "failed", JSON.stringify(busy));
    assert.ok(Date.now() - started < 15_000);
    holder.exec("COMMIT");
    assert.equal(holder.prepare("SELECT count(*) AS n FROM turns").get().n, 3, "the other connection's write is intact");
    holder.close();
  } finally { fixture.cleanup(); }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ao-db-none-"));
  try {
    assert.deepEqual(await compactAoDatabase(empty), { action: "none", reason: "no database yet" });
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
