"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDaemonLogFilter, keepsDaemonLogLine, goDurationMs } = require("../electron/ao-daemon-log.cjs");

const access = (method, status, duration) =>
  `time=2026-10-20T20:56:32.338+08:00 level=INFO msg="http request" id=simon/uWvaNUFOLG-048664 method=${method} path=/api/v1/sessions/reg-machine-117 status=${status} bytes=763 duration=${duration} remote=127.0.0.1:59094`;

test("Go durations read as milliseconds", () => {
  assert.equal(goDurationMs("1.0482ms"), 1.0482);
  assert.equal(goDurationMs("523.4µs"), 0.5234);
  assert.equal(goDurationMs("1.5s"), 1500);
  assert.equal(goDurationMs("2m3.5s"), 123500);
  assert.ok(Number.isNaN(goDurationMs("")));
  assert.ok(Number.isNaN(goDurationMs("fast")));
});

test("debug lines and quick successful reads are dropped, and the rest kept", () => {
  assert.equal(keepsDaemonLogLine('time=2026-10-20T20:56:52.944+08:00 level=DEBUG msg="scm observer: project has no supported SCM origins" project=x'), false);
  assert.equal(keepsDaemonLogLine(access("GET", 200, "1.0482ms")), false);
  assert.equal(keepsDaemonLogLine(access("HEAD", 304, "80µs")), false);
  // Writes, failures and slow reads explain what happened to a turn.
  assert.equal(keepsDaemonLogLine(access("POST", 204, "3ms")), true);
  assert.equal(keepsDaemonLogLine(access("GET", 404, "1ms")), true);
  assert.equal(keepsDaemonLogLine(access("GET", 503, "1ms")), true);
  assert.equal(keepsDaemonLogLine(access("GET", 200, "1.2s")), true);
  assert.equal(keepsDaemonLogLine(access("GET", 200, "soon")), true);
  assert.equal(keepsDaemonLogLine('time=2026-10-20T20:56:52.944+08:00 level=WARN msg="usage source ingestion failed"'), true);
  // A panic's stack carries no level and is always kept.
  assert.equal(keepsDaemonLogLine("goroutine 1 [running]:"), true);
});

test("the filter joins lines split across chunks and flushes the last one", () => {
  const written = [];
  const filter = createDaemonLogFilter((text) => written.push(text));
  const quick = access("GET", 200, "1ms");
  const post = access("POST", 201, "4ms");
  filter.push(Buffer.from(`${quick}\n${post.slice(0, 40)}`));
  assert.deepEqual(written, []);
  filter.push(`${post.slice(40)}\npanic: boom`);
  assert.deepEqual(written, [`${post}\n`]);
  filter.flush();
  assert.deepEqual(written, [`${post}\n`, "panic: boom\n"]);
  filter.flush();
  assert.equal(written.length, 2);
});

test("an endless line is passed on rather than held", () => {
  const written = [];
  const filter = createDaemonLogFilter((text) => written.push(text));
  filter.push("x".repeat(70 * 1024));
  assert.equal(written.length, 1);
  assert.equal(written[0].length, 70 * 1024 + 1);
});
