"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDaemonLogFilter, keepsDaemonLogLine, goDurationMs, daemonLogEvent, SLOW_STAGE_MS } = require("../electron/ao-daemon-log.cjs");

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

test("AO's writer report and a slow start stage become launcher log events; other lines do not", () => {
  const stage = (stageName, duration) =>
    `time=2026-11-09T14:47:31.004+08:00 level=INFO msg="spawn: asynchronous chat stage" sessionID=coding-tools-mcp-280 stage=${stageName} duration=${duration}`;
  // The stack summary is quoted, with escaped quotes inside, and a CRLF line ending is no part of it.
  assert.deepEqual(daemonLogEvent('time=2026-11-09T14:46:17.120+08:00 level=WARN msg="sqlite writer held while writes wait" held=1m3.2s waiting=3 poolWaitCount=9 poolWait=41.5s holder="CreateSession<-Spawn; \\"Retention\\"<-Sweep"\r'),
    { level: "warn", event: "ao.writer_held", detail: { heldMs: 63200, waiting: 3, holder: 'CreateSession<-Spawn; "Retention"<-Sweep' } });
  assert.deepEqual(daemonLogEvent(stage("controller_start", "2m26.4s")),
    { level: "info", event: "ao.start_stage_slow", detail: { session: "coding-tools-mcp-280", stage: "controller_start", ms: 146400 } });
  assert.equal(daemonLogEvent(stage("total", `${SLOW_STAGE_MS}ms`))?.detail.ms, SLOW_STAGE_MS);
  // A quick stage, one whose duration can't be read, and every other line say nothing.
  assert.equal(daemonLogEvent(stage("queue_drain", "12.5ms")), null);
  assert.equal(daemonLogEvent(stage("workspace_create", "soon")), null);
  assert.equal(daemonLogEvent(access("POST", 201, "70s")), null);
  assert.equal(daemonLogEvent('time=2026-11-09T14:46:17.120+08:00 level=WARN msg="usage source ingestion failed"'), null);
  // A report that names no holder still says how long the writer was held.
  assert.deepEqual(daemonLogEvent('level=WARN msg="sqlite writer held while writes wait" held=31s waiting=1').detail, { heldMs: 31000, waiting: 1, holder: "" });
});

test("an endless line is passed on rather than held", () => {
  const written = [];
  const filter = createDaemonLogFilter((text) => written.push(text));
  filter.push("x".repeat(70 * 1024));
  assert.equal(written.length, 1);
  assert.equal(written[0].length, 70 * 1024 + 1);
});

// 2026-11-11: `ao.idle_release_failed {"code":"INTERNAL_ERROR"}` could not be explained, because the
// cause was only in AO's output, which nothing put in the launcher log.
test("AO's failed requests, warnings and errors become launcher log events, the same one at most once a minute", () => {
  const { createDaemonFailureEvents } = require("../electron/ao-daemon-log.cjs");
  let clock = 0;
  const event = createDaemonFailureEvents({ now: () => clock });
  const failed = (session) => `time=2026-11-11T23:23:14.030+08:00 level=INFO msg="http request" id=abc method=POST path=/api/v1/sessions/${session}/exit-agent status=500 bytes=96 duration=5.2s remote=127.0.0.1:5 error="exit agent ${session}: record exit: database is locked (5) (SQLITE_BUSY)"`;
  assert.deepEqual(event(failed("coding-tools-mcp-332")), { level: "warn", event: "ao.request_failed", detail: {
    method: "POST", path: "/api/v1/sessions/coding-tools-mcp-332/exit-agent", status: 500, ms: 5200,
    error: "exit agent coding-tools-mcp-332: record exit: database is locked (5) (SQLITE_BUSY)" } });
  // The same route failing for other sessions is the same kind: not reported again inside a minute.
  assert.equal(event(failed("coding-tools-mcp-333")), null);
  assert.equal(event(failed("clash-of-clan-macro-9")), null);
  clock += 60_001;
  assert.equal(event(failed("coding-tools-mcp-334")).detail.repeats, 2, "the next report says how many it stood for");
  // Requests that did not fail on AO's side, and info lines, are not events.
  assert.equal(event('time=2026-11-11T23:23:14.030+08:00 level=INFO msg="http request" method=POST path=/api/v1/sessions status=409 duration=2ms'), null);
  assert.equal(event('time=2026-11-11T23:23:14.030+08:00 level=INFO msg="http request" method=GET path=/api/v1/sessions status=200 duration=70s'), null);
  assert.equal(event('time=2026-11-11T23:23:14.030+08:00 level=INFO msg="cdc change_log retention pruned rows" rows=400'), null);
  assert.equal(event('time=2026-11-11T23:23:14.030+08:00 level=DEBUG msg="tick"'), null);
  assert.equal(event("not a log line"), null);
  // The writer report keeps its own event.
  assert.equal(event('time=2026-11-11T23:23:14.030+08:00 level=WARN msg="sqlite writer held while writes wait" held=31s waiting=1'), null);

  assert.deepEqual(event('time=2026-11-11T23:23:14.030+08:00 level=WARN msg="usage source ingestion failed" source=4 err="artifact missing"'),
    { level: "warn", event: "ao.daemon_warning", detail: { message: "usage source ingestion failed", source: "4", err: "artifact missing" } });
  assert.equal(event('time=2026-11-11T23:23:15.030+08:00 level=WARN msg="usage source ingestion failed" source=5 err="artifact missing"'), null);
  const stopped = event('level=ERROR msg="persistent chat projection stopped; provider retained for replay" session=s1 kind=turn_completed error="database is locked"');
  assert.equal(stopped.event, "ao.daemon_error");
  assert.deepEqual(stopped.detail, { message: "persistent chat projection stopped; provider retained for replay", session: "s1", kind: "turn_completed", error: "database is locked" });
  // Long values are cut, so one line cannot fill the log.
  const long = event(`level=ERROR msg="${"m".repeat(500)}" error="${"e".repeat(2000)}" other="${"o".repeat(900)}"`);
  assert.equal(long.detail.message.length, 160);
  assert.equal(long.detail.error.length, 400);
  assert.equal(long.detail.other.length, 160);
});

test("the launcher puts AO's failures in its log beside the writer and start-stage events", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../electron/agent-orchestrator-upstream.cjs"), "utf8");
  assert.match(source, /const daemonFailureEvent = createDaemonFailureEvents\(\);/);
  assert.match(source, /const found = daemonLogEvent\(line\) \?\? daemonFailureEvent\(line\);/);
});
