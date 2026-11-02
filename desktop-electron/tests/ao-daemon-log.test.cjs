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

test("UTF-8 text survives every byte boundary", () => {
  const line = 'time=2026-10-20 level=WARN msg="µ μ 中文 😀"\n';
  const bytes = Buffer.from(line);
  for (let split = 1; split < bytes.length; split++) {
    const written = [];
    const filter = createDaemonLogFilter((text) => written.push(text));
    filter.push(bytes.subarray(0, split));
    filter.push(bytes.subarray(split));
    filter.flush();
    assert.equal(written.join(""), line, `split at byte ${split}`);
  }
});

test("split microsecond durations still suppress quick successful reads", () => {
  for (const unit of ["µs", "μs"]) {
    const bytes = Buffer.from(`${access("GET", 200, `80${unit}`)}\n`);
    const split = bytes.indexOf(Buffer.from(unit)) + 1;
    const written = [];
    const filter = createDaemonLogFilter((text) => written.push(text));
    filter.push(bytes.subarray(0, split));
    filter.push(bytes.subarray(split));
    filter.flush();
    assert.deepEqual(written, [], unit);
  }
});

test("mixed byte and text chunks preserve BOMs and text surrogate pairs", () => {
  const written = [];
  const filter = createDaemonLogFilter((text) => written.push(text));
  const bytes = Buffer.from("\uFEFFWARN 中文 ");
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  filter.push(bytes.subarray(0, split));
  filter.push("");
  filter.push(bytes.subarray(split));
  filter.push("\ud83d");
  filter.push("\ude00\n");
  // A decoded text chunk cannot complete an unfinished byte sequence.
  filter.push(Buffer.from([0xe4, 0xb8]));
  filter.push("tail\n");
  filter.flush();
  assert.equal(written.join(""), "\uFEFFWARN 中文 😀\n\uFFFDtail\n");
});

test("flush finishes an incomplete UTF-8 tail once and permits another stream", () => {
  const written = [];
  const filter = createDaemonLogFilter((text) => written.push(text));
  filter.push(Buffer.from("panic: 尾"));
  filter.push(Buffer.from([0xf0, 0x9f]));
  filter.flush();
  filter.flush();
  assert.deepEqual(written, ["panic: 尾\uFFFD\n"]);
  filter.push(Buffer.from("next: 中"));
  filter.flush();
  assert.deepEqual(written, ["panic: 尾\uFFFD\n", "next: 中\n"]);
});

test("each output stream has independent UTF-8 state", () => {
  const stdout = [], stderr = [];
  const out = createDaemonLogFilter((text) => stdout.push(text));
  const err = createDaemonLogFilter((text) => stderr.push(text));
  out.push(Buffer.from([0xe4]));
  err.push(Buffer.from("WARN: µ\n"));
  out.push(Buffer.from([0xb8, 0xad, 0x0a]));
  out.flush();
  err.flush();
  assert.deepEqual(stdout, ["中\n"]);
  assert.deepEqual(stderr, ["WARN: µ\n"]);
});

test("an endless line is passed on rather than held", () => {
  const written = [];
  const filter = createDaemonLogFilter((text) => written.push(text));
  filter.push("x".repeat(70 * 1024));
  assert.equal(written.length, 1);
  assert.equal(written[0].length, 70 * 1024 + 1);
});
