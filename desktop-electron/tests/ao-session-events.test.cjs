const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createAoSessionEvents, createChangePulse, parseSseFrames, sessionChange } = require("../electron/ao-session-events.cjs");

const frame = (seq, body) => `id: ${seq}\nevent: ${body.type}\ndata: ${JSON.stringify({ seq, ...body })}\n\n`;

test("SSE frames split on blank lines; comments and partial frames wait", () => {
  const { frames, rest } = parseSseFrames(":\n\nid: 4\r\nevent: session_updated\r\ndata: {\"a\":1}\r\n\r\nid: 5\ndata: {\"b\"");
  assert.deepEqual(frames, [{ id: "4", event: "session_updated", data: "{\"a\":1}" }]);
  assert.equal(rest, "id: 5\ndata: {\"b\"");
  assert.equal(parseSseFrames("data: " + "x".repeat(70 * 1024)).rest, "", "an endless frame is dropped, not buffered");
});

test("a CDC frame becomes a session change; conversation rows are told apart from state changes", () => {
  assert.deepEqual(sessionChange({ data: JSON.stringify({ type: "session_updated", sessionId: "s-1", payload: { conversationId: "c-1" } }) }),
    { sessionId: "s-1", type: "session_updated", conversation: true });
  assert.deepEqual(sessionChange({ data: JSON.stringify({ type: "session_updated", sessionId: "s-1", payload: { activity: "idle" } }) }),
    { sessionId: "s-1", type: "session_updated", conversation: false });
  assert.equal(sessionChange({ data: JSON.stringify({ type: "session_updated", payload: { kind: "model_catalog" } }) }), null);
  assert.equal(sessionChange({ data: JSON.stringify({ sessionId: "../etc" }) }), null);
  assert.equal(sessionChange({ data: "not json" }), null);
});

test("change pulse sends the first change at once and folds a burst into one trailing batch", () => {
  let clock = 1_000;
  const sent = [], timers = [];
  const pulse = createChangePulse(payload => sent.push(payload), {
    now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  pulse.session("a");
  assert.deepEqual(sent, [{ sessions: ["a"], runs: [] }], "leading edge");
  clock += 20; pulse.session("b"); pulse.session("b"); pulse.run("ws", "run-1");
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 130);
  clock += 130; timers[0].fn();
  assert.deepEqual(sent[1], { sessions: ["b"], runs: ["ws:run-1"] });
});

test("the watcher starts at the head, resumes from its cursor and stops when nobody listens", async () => {
  const requests = [];
  let respond;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/event-stream" });
    respond = response;
    if (requests.length === 1) {
      response.write(frame(41, { type: "session_updated", sessionId: "s-1", payload: { conversationId: "c" } }));
      response.write(frame(42, { type: "session_updated", projectId: "p", payload: { kind: "model_catalog" } }));
      setTimeout(() => response.end(), 20);
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const changes = [];
  const events = createAoSessionEvents({ port: async () => port, setTimer: (fn) => setTimeout(fn, 5) });
  const stop = events.subscribe(change => changes.push(change));
  try {
    for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(requests[0], /after=9007199254740991$/, "a new watcher starts at the head instead of replaying the log");
    assert.equal(requests[1], "/api/v1/events?after=42", "a reconnect resumes after the last event seen");
    assert.deepEqual(changes, [{ sessionId: "s-1", type: "session_updated", conversation: true }]);
  } finally {
    stop();
    respond?.end();
    await new Promise(resolve => server.close(resolve));
  }
});

test("the watcher waits for AO instead of starting it", async () => {
  let asked = 0;
  const timers = [];
  const events = createAoSessionEvents({ port: async () => { asked++; throw new Error("AO is not running"); },
    setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer: () => {} });
  const stop = events.subscribe(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(asked, 1);
  assert.equal(timers.length, 1, "it retries later");
  stop();
});
