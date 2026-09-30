const assert = require("node:assert/strict");
const test = require("node:test");

const { createMcpEventMonitor, EVENTS, proxyTarget, stallMinutesFrom, redact } = require("../electron/mcp-events-monitor.cjs");

function harness(options = {}) {
  let clock = Date.parse("2026-09-30T12:00:00Z");
  const reports = [];
  const configured = [];
  const probes = { http: [], tcp: [] };
  const monitor = createMcpEventMonitor({
    report: async (entry) => {
      if (options.failReports?.()) throw new Error("headless not running");
      reports.push(entry);
    },
    configure: async (proxy) => { configured.push(proxy); },
    now: () => clock,
    stallMinutes: 5,
    bridgeHealthUrl: () => options.bridge ?? null,
    proxyUrl: () => options.proxy ?? null,
    probeHttp: async () => probes.http.shift() ?? { ok: true },
    probeTcp: async () => probes.tcp.shift() ?? { ok: true },
  });
  return {
    monitor, reports, configured, probes,
    advance: (ms) => { clock += ms; },
    emitted: (event) => reports.filter((entry) => entry.event === event && !entry.resolve),
    resolved: () => reports.filter((entry) => entry.resolve),
  };
}

test("a failed or aborted web turn is reported once with conversation context", async () => {
  const h = harness();
  const key = "a".repeat(64);
  h.monitor.turnEvent({ type: "start", traceId: "trace_1", conversationKey: key, manual: false });
  h.monitor.turnEvent({ type: "end", traceId: "trace_1", status: "failed", message: "upstream said Bearer abc.def", manual: false });
  h.monitor.turnEvent({ type: "end", traceId: "trace_1", status: "failed", manual: false });
  h.monitor.turnEvent({ type: "end", traceId: "trace_2", status: "completed", manual: false });
  h.monitor.turnEvent({ type: "end", traceId: "trace_3", status: "aborted", manual: true });
  await h.monitor.flush();
  const failed = h.emitted(EVENTS.webTurnFailed);
  assert.equal(failed.length, 2);
  assert.equal(failed[0].data.incident_id, "web_turn:trace_1");
  assert.equal(failed[0].data.status, "failed");
  assert.equal(failed[0].data.turn_mode, "automatic");
  assert.equal(failed[0].data.conversation_key, key);
  assert.equal(failed[0].workspace_id, null);
  assert.ok(!failed[0].data.reason.includes("abc.def"));
  assert.deepEqual(failed[0].data.recovery_tools, ["server_info"]);
  assert.equal(failed[1].data.turn_mode, "manual");
  assert.equal(failed[1].data.reason_code, "aborted");
});

test("an automatic turn without heartbeats stalls once and re-arms after progress", async () => {
  const h = harness();
  h.monitor.turnEvent({ type: "start", traceId: "trace_s", manual: false });
  h.monitor.turnEvent({ type: "start", traceId: "manual_s", manual: true });
  h.advance(4 * 60_000);
  await h.monitor.tick();
  assert.equal(h.emitted(EVENTS.runStalled).length, 0);
  h.advance(2 * 60_000);
  await h.monitor.tick();
  await h.monitor.tick();
  const stalled = h.emitted(EVENTS.runStalled);
  assert.equal(stalled.length, 1, "manual Zero Risk turns wait on the user and never stall");
  assert.equal(stalled[0].data.run_kind, "web_turn");
  assert.equal(stalled[0].data.stall_threshold_seconds, 300);
  assert.ok(stalled[0].data.stalled_for_seconds >= 360);

  h.monitor.turnEvent({ type: "heartbeat", traceId: "trace_s" });
  await h.monitor.flush();
  assert.equal(h.resolved().length, 1);
  assert.equal(h.resolved()[0].data.incident_id, stalled[0].data.incident_id);
  h.advance(6 * 60_000);
  await h.monitor.tick();
  const again = h.emitted(EVENTS.runStalled);
  assert.equal(again.length, 2);
  assert.notEqual(again[1].data.incident_id, again[0].data.incident_id);
});

test("orchestrator runs report attention, stalls without node changes, and clear on user stop", async () => {
  const h = harness();
  const run = { workspaceId: "ws-1", runId: "run-1" };
  h.monitor.runState({ ...run, status: "running", fingerprint: "a:running" });
  h.advance(6 * 60_000);
  await h.monitor.tick();
  const stalled = h.emitted(EVENTS.runStalled);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].workspace_id, "ws-1");
  assert.equal(stalled[0].data.run_kind, "orchestrator_run");
  assert.equal(stalled[0].data.run_id, "run-1");

  h.monitor.runState({ ...run, status: "running", fingerprint: "a:finished,b:running" });
  h.monitor.runState({ ...run, status: "running", fingerprint: "a:finished,b:running", attention: "pending_approval", detail: "Waiting for your tool approval" });
  h.monitor.runState({ ...run, status: "running", fingerprint: "a:finished,b:running", attention: "pending_approval" });
  h.advance(10 * 60_000);
  await h.monitor.tick();
  await h.monitor.flush();
  const attention = h.emitted(EVENTS.missionNeedsAttention);
  assert.equal(attention.length, 1, "a pending approval is one incident, not a stall");
  assert.equal(attention[0].data.attention, "pending_approval");
  assert.equal(attention[0].data.workspace_id, "ws-1");
  assert.equal(h.emitted(EVENTS.runStalled).length, 1);

  h.monitor.runState({ ...run, status: "held", detail: "Run grant expired sk-live_1234567890", attention: "error" });
  await h.monitor.flush();
  const errors = h.emitted(EVENTS.missionNeedsAttention).filter((entry) => entry.data.attention === "error");
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].data.reason.includes("sk-live"));

  const before = h.reports.length;
  h.monitor.runState({ ...run, status: "held", stopped: true, attention: null });
  await h.monitor.flush();
  const after = h.reports.slice(before);
  assert.ok(after.every((entry) => entry.resolve), "a user stop only resolves incidents");
  assert.equal(h.monitor.snapshot().trackedRuns, 0);
  assert.equal(h.monitor.snapshot().openIncidents.length, 0);
});

test("a held run with unresolved cards asks for attention unless the user stopped it", async () => {
  const h = harness();
  h.monitor.runState({ workspaceId: "ws", runId: "r", status: "held", attention: "stopped", detail: "Run stopped; inspect the saved cards" });
  h.monitor.runState({ workspaceId: "ws", runId: "r2", status: "held", stopped: true, attention: null });
  await h.monitor.flush();
  const attention = h.emitted(EVENTS.missionNeedsAttention);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].data.run_id, "r");
  assert.equal(attention[0].data.status, "held");
});

test("bridge and proxy outages need two failed probes, report once, and re-arm after recovery", async () => {
  const h = harness({ bridge: "http://127.0.0.1:17841/healthz", proxy: "http://user:pw@127.0.0.1:17891" });
  h.probes.http.push({ ok: false, code: "ECONNREFUSED" }, { ok: false, code: "ECONNREFUSED" }, { ok: false, code: "ECONNREFUSED" }, { ok: true });
  h.probes.tcp.push({ ok: true }, { ok: true }, { ok: true }, { ok: true });
  await h.monitor.tick();
  assert.equal(h.emitted(EVENTS.bridgeDown).length, 0);
  await h.monitor.tick();
  await h.monitor.tick();
  const down = h.emitted(EVENTS.bridgeDown);
  assert.equal(down.length, 1);
  assert.equal(down[0].data.component, "codex_bridge");
  assert.equal(down[0].data.target, "127.0.0.1:17841");
  await h.monitor.tick();
  assert.equal(h.resolved().length, 1);
  assert.deepEqual(h.configured.at(-1), "http://user:pw@127.0.0.1:17891");

  h.monitor.nativeFetchFailed({ netError: "ERR_CONNECTION_RESET" });
  h.monitor.nativeFetchFailed({ netError: "ERR_PROXY_CONNECTION_FAILED" });
  h.monitor.nativeFetchFailed({ netError: "ERR_PROXY_CONNECTION_FAILED" });
  await h.monitor.flush();
  const proxy = h.emitted(EVENTS.bridgeDown).filter((entry) => entry.data.component === "proxy_route");
  assert.equal(proxy.length, 1);
  assert.equal(proxy[0].data.target, "127.0.0.1:17891", "credentials never leave the proxy URL");
  assert.equal(proxy[0].data.net_error, "ERR_PROXY_CONNECTION_FAILED");
  // A reachable proxy port does not prove the route works: only a good request recovers.
  const resolvedBefore = h.resolved().length;
  await h.monitor.tick();
  h.monitor.nativeFetchFailed({ netError: "ERR_PROXY_CONNECTION_FAILED" });
  await h.monitor.flush();
  assert.equal(h.resolved().length, resolvedBefore);
  assert.equal(h.emitted(EVENTS.bridgeDown).filter((entry) => entry.data.component === "proxy_route").length, 1);
  h.monitor.nativeFetchSucceeded();
  h.monitor.nativeFetchFailed({ netError: "ERR_PROXY_CONNECTION_FAILED" });
  await h.monitor.flush();
  assert.equal(h.emitted(EVENTS.bridgeDown).filter((entry) => entry.data.component === "proxy_route").length, 2);
});

test("no probe runs for a bridge that is not expected to be up", async () => {
  const h = harness();
  h.probes.http.push({ ok: false }, { ok: false }, { ok: false });
  await h.monitor.tick();
  await h.monitor.tick();
  assert.equal(h.emitted(EVENTS.bridgeDown).length, 0);
  assert.equal(h.probes.http.length, 3);
});

test("reports wait for the headless service and are rate limited", async () => {
  let down = true;
  const h = harness({ failReports: () => down });
  h.monitor.turnEvent({ type: "end", traceId: "trace_q", status: "failed" });
  await h.monitor.flush();
  assert.equal(h.reports.length, 0);
  assert.equal(h.monitor.snapshot().pending, 1);
  down = false;
  await h.monitor.tick();
  assert.equal(h.emitted(EVENTS.webTurnFailed).length, 1);

  for (let index = 0; index < 40; index += 1) {
    h.monitor.turnEvent({ type: "end", traceId: `trace_${index}_x`, status: "failed" });
  }
  await h.monitor.flush();
  assert.equal(h.emitted(EVENTS.webTurnFailed).length, 20);
});

test("helpers keep credentials out of targets and bound the stall setting", () => {
  assert.equal(proxyTarget("http://u:p@127.0.0.1:17891").label, "127.0.0.1:17891");
  assert.equal(proxyTarget("socks5://127.0.0.1:1080"), null);
  assert.equal(proxyTarget(""), null);
  assert.equal(stallMinutesFrom({}), 5);
  assert.equal(stallMinutesFrom({ CODING_TOOLS_EVENT_STALL_MINUTES: "12" }), 12);
  assert.equal(stallMinutesFrom({ CODING_TOOLS_EVENT_STALL_MINUTES: "0" }), 5);
  assert.ok(!redact("https://u:secret@example.test").includes("secret"));
});
