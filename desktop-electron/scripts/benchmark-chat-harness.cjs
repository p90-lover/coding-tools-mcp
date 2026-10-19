"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");

const BASELINE = "9e42fa9555b2b4a5428b835d9f415c6e9a33832b";
const MODULE = "desktop-electron/electron/agent-orchestrator-upstream.cjs";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

// Execute the production observe/helpers, using the same seam as upstream.test.cjs.
function productionHarness(source, context) {
  const section = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, "Production observation source boundary changed");
    return source.slice(from, to);
  };
  const method = section("    async observe(id", "    // A standalone AO terminal").trim().replace(/,$/, "");
  const helpers = section("  async function chatHostGone", "  // Mission-owned AO calls.");
  const identity = section("  const sessionId =", "  async function projectFor");
  const api = section("  async function internalApi(", "  const agentId =");
  const states = source.match(/const TERMINAL_TURN_STATES = .*;/)?.[0];
  assert.ok(states, "Production terminal-state declaration changed");
  return vm.runInNewContext(states + helpers + identity + api + "({" + method
    + ", invalidate: typeof invalidateObservations === 'function' ? invalidateObservations : () => {} })", {
    Buffer, path, fs: { readFileSync() { throw new Error("No host files in offline fixture"); } },
    net: { connect() { throw new Error("Network is forbidden in offline fixture"); } },
    dataRoot: "", agentTools: null, start: async () => {}, lifecycleGeneration: 0,
    observeTui: async () => { throw new Error("Not a TUI fixture"); }, ...context,
  });
}

async function runFixture(source) {
  let clock = 1000;
  const state = { status: "working", turn: "t1", turnState: "running", text: "initial live output" };
  const counts = { requests: 0, conversation_reads: 0, response_json_bytes: 0, simulated_serial_io_ms: 0 };
  const upstream = productionHarness(source, {
    Date: class extends Date { static now() { return clock; } },
    aoErrorMessage: result => result.data.message,
    requestApi: async (method, endpoint) => {
      counts.requests++; counts.simulated_serial_io_ms += 10; clock += 10;
      let data;
      if (method === "POST" && endpoint.endsWith("/messages")) {
        state.turn = "t2"; state.turnState = "running"; state.status = "working"; state.text = "follow-up live output";
        data = { turnId: "t2", state: "running" };
      } else if (method === "POST" && endpoint.endsWith("/interrupt")) {
        state.turnState = "interrupted"; state.status = "idle"; data = { ok: true };
      } else if (method === "GET" && endpoint.includes("/conversation?")) {
        counts.conversation_reads++;
        data = {
          turns: [{ id: state.turn, state: state.turnState }],
          messages: [
            ...Array.from({ length: 40 }, (_, index) => ({ id: "old-" + index, role: "assistant",
              turnId: "previous-turn", sequence: index, text: "old context ".repeat(80), streaming: false })),
            { id: "current", role: "assistant", turnId: state.turn, sequence: 50,
              text: state.text, streaming: state.turnState === "running" },
          ],
        };
      } else if (method === "GET" && endpoint === "/api/v1/sessions/s") {
        data = { session: { id: "s", mode: "chat", status: state.status } };
      } else throw new Error("Unexpected offline API call: " + method + " " + endpoint);
      counts.response_json_bytes += Buffer.byteLength(JSON.stringify(data));
      return { ok: true, data: JSON.parse(JSON.stringify(data)) };
    },
  });
  const concurrent = await Promise.all([upstream.observe("s", "t1"), upstream.observe("s", "t1")]);
  assert.ok(concurrent.every(value => value.liveOutput === "initial live output"));
  for (let index = 0; index < 3; index++) {
    clock += 100;
    assert.equal((await upstream.observe("s", "t1")).liveOutput, "initial live output");
  }
  state.text = "CDC updated live row";
  upstream.invalidate("s");
  assert.equal((await upstream.observe("s", "t1")).liveOutput, state.text);
  clock += 1501;
  state.text = "missed-event reconciliation";
  assert.equal((await upstream.observe("s", "t1")).liveOutput, state.text);
  await upstream.send("s", "harmless fixture follow-up", "fixture-message");
  assert.equal((await upstream.observe("s", "t2")).turnId, "t2");
  await upstream.interrupt("s");
  assert.equal((await upstream.observe("s", "t2")).turnState, "interrupted");
  state.status = "idle"; state.turnState = "completed"; state.text = "exact authoritative final answer";
  const final = await upstream.observe("s", "t2");
  assert.equal(final.turnState, "completed");
  assert.equal(final.answer, state.text);
  state.text = "updated authoritative final answer";
  const revised = await upstream.observe("s", "t2");
  assert.equal(revised.answer, state.text, "terminal results are freshly read");
  return {
    ...counts, simulated_elapsed_ms: clock - 1000,
    final_answer: revised.answer,
    acceptance: { concurrent_output: true, cdc_refresh: true, missed_event_reconciliation: true,
      followup_turn: true, interruption: true, terminal_refresh: true },
  };
}

async function benchmark({ repoRoot = path.resolve(__dirname, "../.."), baselineRef = BASELINE } = {}) {
  if (typeof baselineRef !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(baselineRef)) throw new Error("Choose a git baseline ref");
  const baselineCommit = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", baselineRef + "^{commit}"], { encoding: "utf8" }).trim();
  const baselineSource = execFileSync("git", ["-C", repoRoot, "show", baselineCommit + ":" + MODULE], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const candidateSource = fs.readFileSync(path.join(repoRoot, MODULE), "utf8");
  const baseline = await runFixture(baselineSource);
  const candidate = await runFixture(candidateSource);
  assert.equal(candidate.final_answer, baseline.final_answer);
  assert.ok(candidate.conversation_reads < baseline.conversation_reads, "Candidate must reduce conversation reads in this fixture");
  assert.ok(candidate.response_json_bytes < baseline.response_json_bytes, "Candidate must reduce transferred JSON in this fixture");
  return {
    version: 1, mode: "offline_production_observation_fixture", model: null, network: false,
    baseline_commit: baselineCommit, baseline_source_sha256: hash(baselineSource),
    candidate_source_sha256: hash(candidateSource),
    timing_basis: "simulated serialized backend: 10 ms per request; same 100 ms poll intervals and 1501 ms reconciliation wait",
    limitation: "Controlled request/JSON-byte comparison, not a live model or end-to-end latency benchmark",
    baseline, candidate,
    comparison: { fewer_requests: baseline.requests - candidate.requests,
      fewer_conversation_reads: baseline.conversation_reads - candidate.conversation_reads,
      fewer_response_json_bytes: baseline.response_json_bytes - candidate.response_json_bytes,
      final_answer_identical: true },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--baseline-ref")) {
    process.stderr.write("Usage: node benchmark-chat-harness.cjs [--baseline-ref <git-ref>]\n");
    process.exitCode = 1;
  } else benchmark({ baselineRef: args[1] ?? BASELINE }).then(
    report => process.stdout.write(JSON.stringify(report, null, 2) + "\n"),
    error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
}
module.exports = { benchmark, runFixture };
