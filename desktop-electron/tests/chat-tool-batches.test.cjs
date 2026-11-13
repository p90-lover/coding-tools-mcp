"use strict";
require("./support/temp-dirs.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  SAFE_READ_TOOLS,
  MAX_CONCURRENT_READS,
  FAST_EXECUTION_GUIDANCE,
  isSafeReadToolCall,
  dispatchToolBatch,
} = require("../electron/chat-tool-batches.cjs");

/**
 * Creates a deterministic promise gate without timers or sleeps.
 */
function createGate() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("SAFE_READ_TOOLS contains exactly the 15 allowlisted tools", () => {
  const expected = [
    "read_file",
    "list_dir",
    "list_files",
    "search_text",
    "grep_text",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_blame",
    "get_plan",
    "get_current_time",
    "server_info",
    "read_output",
    "list_commands",
  ];
  assert.equal(SAFE_READ_TOOLS.size, 15);
  for (const name of expected) {
    assert.ok(SAFE_READ_TOOLS.has(name), `Missing expected safe tool: ${name}`);
  }
});

test("isSafeReadToolCall does not infer trust from prefixes or readOnlyHint", () => {
  // Safe tools
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "read_file" } }), true);
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "git_diff" } }), true);

  // Prefix read_ or get_ or list_ but NOT on allowlist -> false
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "read_secrets" } }), false);
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "get_environment" } }), false);
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "list_processes" } }), false);

  // readOnlyHint annotation present on a non-allowlisted tool -> false
  assert.equal(isSafeReadToolCall({
    method: "tools/call",
    params: { name: "custom_inspect", annotations: { readOnlyHint: true } },
  }), false);
  assert.equal(isSafeReadToolCall({
    method: "tools/call",
    params: { name: "delete_file", annotations: { readOnlyHint: true } },
  }), false);

  // Protocol messages or mutations -> false
  assert.equal(isSafeReadToolCall({ method: "initialize", params: {} }), false);
  assert.equal(isSafeReadToolCall({ method: "ping" }), false);
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "apply_patch" } }), false);
  assert.equal(isSafeReadToolCall({ method: "tools/call", params: { name: "exec_command" } }), false);
  assert.equal(isSafeReadToolCall(null), false);
  assert.equal(isSafeReadToolCall({}), false);
});

test("dispatchToolBatch runs safe reads in waves of max 4 using deterministic gates", async () => {
  const toolNames = [
    "read_file", "list_dir", "list_files", "search_text", // Wave 1 (4)
    "grep_text", "git_status", "git_diff", "git_log",     // Wave 2 (4)
    "git_show", "git_blame",                             // Wave 3 (2)
  ];

  const messages = toolNames.map((name, index) => ({
    jsonrpc: "2.0",
    id: index,
    method: "tools/call",
    params: { name, arguments: {} },
  }));

  const gateWave1 = createGate();
  const gateWave2 = createGate();
  const gateWave3 = createGate();

  const wave1Started = createGate();
  const wave2Started = createGate();
  const wave3Started = createGate();

  let activeCount = 0;
  let maxActive = 0;
  let wave1Count = 0;
  let wave2Count = 0;
  let wave3Count = 0;

  const dispatch = async (msg) => {
    activeCount++;
    if (activeCount > maxActive) maxActive = activeCount;
    assert.ok(activeCount <= MAX_CONCURRENT_READS, `Active reads exceeded max 4: ${activeCount}`);

    const id = msg.id;
    if (id < 4) {
      wave1Count++;
      if (wave1Count === 4) wave1Started.resolve();
      await gateWave1.promise;
    } else if (id < 8) {
      wave2Count++;
      if (wave2Count === 4) wave2Started.resolve();
      await gateWave2.promise;
    } else {
      wave3Count++;
      if (wave3Count === 2) wave3Started.resolve();
      await gateWave3.promise;
    }

    activeCount--;
    return { jsonrpc: "2.0", id: msg.id, result: { done: msg.params.name } };
  };

  const batchPromise = dispatchToolBatch(messages, dispatch);

  // Deterministically verify wave 1 reaches exactly 4 concurrent in-flight calls
  await wave1Started.promise;
  assert.equal(activeCount, 4);
  assert.equal(wave1Count, 4);
  assert.equal(wave2Count, 0, "Wave 2 must not start while Wave 1 is running");
  assert.equal(wave3Count, 0, "Wave 3 must not start while Wave 1 is running");

  // Release wave 1
  gateWave1.resolve();

  // Deterministically verify wave 2 reaches exactly 4 concurrent in-flight calls
  await wave2Started.promise;
  assert.equal(activeCount, 4);
  assert.equal(wave1Count, 4);
  assert.equal(wave2Count, 4);
  assert.equal(wave3Count, 0, "Wave 3 must not start while Wave 2 is running");

  // Release wave 2
  gateWave2.resolve();

  // Deterministically verify wave 3 reaches exactly 2 concurrent in-flight calls
  await wave3Started.promise;
  assert.equal(activeCount, 2);
  assert.equal(wave3Count, 2);

  // Release wave 3
  gateWave3.resolve();

  const answers = await batchPromise;
  assert.equal(answers.length, 10);
  assert.equal(maxActive, 4);

  // Verify answer order and IDs match input order
  for (let i = 0; i < 10; i++) {
    assert.equal(answers[i].id, i);
    assert.equal(answers[i].result.done, toolNames[i]);
  }
});

test("dispatchToolBatch preserves response order regardless of completion order", async () => {
  const messages = [
    { jsonrpc: "2.0", id: "call-0", method: "tools/call", params: { name: "read_file" } },
    { jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "list_dir" } },
    { jsonrpc: "2.0", id: "call-2", method: "tools/call", params: { name: "get_plan" } },
    { jsonrpc: "2.0", id: "call-3", method: "tools/call", params: { name: "server_info" } },
  ];

  const gates = [createGate(), createGate(), createGate(), createGate()];
  const allStarted = createGate();
  let startedCount = 0;

  const dispatch = async (msg) => {
    const idx = Number(msg.id.split("-")[1]);
    startedCount++;
    if (startedCount === 4) allStarted.resolve();
    await gates[idx].promise;
    return { jsonrpc: "2.0", id: msg.id, result: { order: idx } };
  };

  const batchPromise = dispatchToolBatch(messages, dispatch);
  await allStarted.promise;

  // Resolve promises out of order: 3, then 1, then 0, then 2
  gates[3].resolve();
  gates[1].resolve();
  gates[0].resolve();
  gates[2].resolve();

  const answers = await batchPromise;
  assert.equal(answers.length, 4);
  assert.equal(answers[0].id, "call-0");
  assert.equal(answers[0].result.order, 0);
  assert.equal(answers[1].id, "call-1");
  assert.equal(answers[1].result.order, 1);
  assert.equal(answers[2].id, "call-2");
  assert.equal(answers[2].result.order, 2);
  assert.equal(answers[3].id, "call-3");
  assert.equal(answers[3].result.order, 3);
});

test("dispatchToolBatch enforces barrier for mutations and never overlaps across barrier", async () => {
  const messages = [
    { jsonrpc: "2.0", id: "r1", method: "tools/call", params: { name: "read_file" } },
    { jsonrpc: "2.0", id: "r2", method: "tools/call", params: { name: "git_status" } },
    { jsonrpc: "2.0", id: "m1", method: "tools/call", params: { name: "apply_patch" } }, // Barrier
    { jsonrpc: "2.0", id: "r3", method: "tools/call", params: { name: "git_diff" } },
    { jsonrpc: "2.0", id: "r4", method: "tools/call", params: { name: "read_output" } },
  ];

  const gateReads1 = createGate();
  const gateMutation = createGate();
  const gateReads2 = createGate();

  const reads1Started = createGate();
  const mutationStarted = createGate();
  const reads2Started = createGate();

  let r1Count = 0;
  let r2Count = 0;
  let activeCalls = 0;
  let mutationRan = false;
  let reads1Finished = false;

  const dispatch = async (msg) => {
    activeCalls++;
    const id = msg.id;

    if (id === "r1" || id === "r2") {
      assert.equal(mutationRan, false, "Mutation must not run before or during first reads");
      r1Count++;
      if (r1Count === 2) reads1Started.resolve();
      await gateReads1.promise;
      activeCalls--;
      return { jsonrpc: "2.0", id, result: "ok" };
    }

    if (id === "m1") {
      assert.equal(reads1Finished, true, "First wave of reads must finish before mutation runs");
      assert.equal(activeCalls, 1, "Mutation must run alone as an awaited barrier");
      mutationRan = true;
      mutationStarted.resolve();
      await gateMutation.promise;
      activeCalls--;
      return { jsonrpc: "2.0", id, result: "patched" };
    }

    if (id === "r3" || id === "r4") {
      assert.equal(mutationRan, true, "Second wave of reads must run only after mutation");
      r2Count++;
      if (r2Count === 2) reads2Started.resolve();
      await gateReads2.promise;
      activeCalls--;
      return { jsonrpc: "2.0", id, result: "ok" };
    }
  };

  const batchPromise = dispatchToolBatch(messages, dispatch);

  // Verify r1 and r2 are running in parallel and mutation has not started
  await reads1Started.promise;
  assert.equal(r1Count, 2);
  assert.equal(mutationRan, false);

  // Release first reads
  reads1Finished = true;
  gateReads1.resolve();

  // Verify mutation starts alone
  await mutationStarted.promise;
  assert.equal(r2Count, 0, "Second reads must not start while mutation is running");

  // Release mutation
  gateMutation.resolve();

  // Verify second reads start in parallel
  await reads2Started.promise;
  assert.equal(r2Count, 2);

  // Release second reads
  gateReads2.resolve();

  const answers = await batchPromise;
  assert.equal(answers.length, 5);
  assert.deepEqual(answers.map((a) => a.id), ["r1", "r2", "m1", "r3", "r4"]);
});

test("dispatchToolBatch enforces barrier for GUI, protocol messages, and unknown tools", async () => {
  const messages = [
    { jsonrpc: "2.0", id: "proto-init", method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: "read-1", method: "tools/call", params: { name: "read_file" } },
    { jsonrpc: "2.0", id: "gui-preview", method: "tools/call", params: { name: "preview_render" } },
    { jsonrpc: "2.0", id: "unknown-prefix", method: "tools/call", params: { name: "read_passwords" } }, // Prefix read_ but unknown
    { jsonrpc: "2.0", id: "unknown-hint", method: "tools/call", params: { name: "delete_item", annotations: { readOnlyHint: true } } },
    { jsonrpc: "2.0", id: "read-2", method: "tools/call", params: { name: "list_commands" } },
  ];

  const inFlight = new Set();
  const maxInFlightPerMessage = {};

  const dispatch = async (msg) => {
    inFlight.add(msg.id);
    maxInFlightPerMessage[msg.id] = inFlight.size;

    // For barrier messages, inFlight must be exactly 1
    if (msg.id !== "read-1" && msg.id !== "read-2") {
      assert.equal(inFlight.size, 1, `Barrier message ${msg.id} must run strictly alone`);
    }

    inFlight.delete(msg.id);
    return { jsonrpc: "2.0", id: msg.id, result: `done-${msg.id}` };
  };

  const answers = await dispatchToolBatch(messages, dispatch);
  assert.equal(answers.length, 6);
  assert.deepEqual(answers.map((a) => a.id), [
    "proto-init",
    "read-1",
    "gui-preview",
    "unknown-prefix",
    "unknown-hint",
    "read-2",
  ]);
});

test("dispatchToolBatch does not drop errors and correctly handles null/undefined answers", async () => {
  const messages = [
    { jsonrpc: "2.0", id: "ok-1", method: "tools/call", params: { name: "read_file" } },
    { jsonrpc: "2.0", id: "err-2", method: "tools/call", params: { name: "list_dir" } },
    { jsonrpc: "2.0", method: "notifications/progress", params: { message: "working" } }, // Notification returns null
    { jsonrpc: "2.0", id: "ok-3", method: "tools/call", params: { name: "git_status" } },
  ];

  const dispatch = async (msg) => {
    if (msg.id === "ok-1") {
      return { jsonrpc: "2.0", id: "ok-1", result: { content: "hello" } };
    }
    if (msg.id === "err-2") {
      // Error response object must NOT be dropped
      return { jsonrpc: "2.0", id: "err-2", error: { code: -32603, message: "Directory missing" } };
    }
    if (!msg.id) {
      // Notifications produce no answer (null or undefined)
      return null;
    }
    if (msg.id === "ok-3") {
      return { jsonrpc: "2.0", id: "ok-3", result: { clean: true } };
    }
  };

  const answers = await dispatchToolBatch(messages, dispatch);
  assert.equal(answers.length, 3, "Notification returning null must be omitted without dropping other answers");
  assert.equal(answers[0].id, "ok-1");
  assert.equal(answers[0].result.content, "hello");
  assert.equal(answers[1].id, "err-2");
  assert.equal(answers[1].error.code, -32603);
  assert.equal(answers[2].id, "ok-3");
  assert.equal(answers[2].result.clean, true);
});

test("dispatchToolBatch propagates rejections without swallowing errors", async () => {
  const messages = [
    { jsonrpc: "2.0", id: "r1", method: "tools/call", params: { name: "read_file" } },
    { jsonrpc: "2.0", id: "r2", method: "tools/call", params: { name: "git_diff" } },
  ];

  const expectedError = new Error("Disk I/O failure");
  const dispatch = async (msg) => {
    if (msg.id === "r2") {
      throw expectedError;
    }
    return { jsonrpc: "2.0", id: msg.id, result: "ok" };
  };

  await assert.rejects(
    async () => dispatchToolBatch(messages, dispatch),
    (err) => err === expectedError
  );
});

test("dispatchToolBatch processes all 15 allowlisted tools in waves", async () => {
  const all15 = Array.from(SAFE_READ_TOOLS);
  const messages = all15.map((name, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "tools/call",
    params: { name },
  }));

  let active = 0;
  let maxActive = 0;
  const dispatch = async (msg) => {
    active++;
    if (active > maxActive) maxActive = active;
    active--;
    return { jsonrpc: "2.0", id: msg.id, result: msg.params.name };
  };

  const answers = await dispatchToolBatch(messages, dispatch);
  assert.equal(answers.length, 15);
  assert.ok(maxActive <= MAX_CONCURRENT_READS);
  for (let i = 0; i < 15; i++) {
    assert.equal(answers[i].id, i);
    assert.equal(answers[i].result, all15[i]);
  }
});

test("dispatchToolBatch forwards extra arguments to dispatch function", async () => {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } },
  ];

  const fakeEntry = { id: "entry-1" };
  const fakeChannel = { signal: {} };

  const dispatch = async (msg, entry, channel) => {
    assert.equal(entry, fakeEntry);
    assert.equal(channel, fakeChannel);
    return { jsonrpc: "2.0", id: msg.id, result: "forwarded" };
  };

  const answers = await dispatchToolBatch(messages, dispatch, fakeEntry, fakeChannel);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].result, "forwarded");
});

test("dispatchToolBatch handles edge cases: empty, single, non-array", async () => {
  const dispatch = async (msg) => ({ jsonrpc: "2.0", id: msg.id, result: "ok" });

  assert.deepEqual(await dispatchToolBatch([], dispatch), []);
  assert.deepEqual(await dispatchToolBatch(null, dispatch), []);
  assert.deepEqual(await dispatchToolBatch(undefined, dispatch), []);

  const single = { jsonrpc: "2.0", id: "single", method: "tools/call", params: { name: "git_status" } };
  const singleResult = await dispatchToolBatch(single, dispatch);
  assert.equal(singleResult.length, 1);
  assert.equal(singleResult[0].id, "single");
});

test("FAST_EXECUTION_GUIDANCE contains all required guidance instructions", () => {
  assert.equal(typeof FAST_EXECUTION_GUIDANCE, "string");
  assert.ok(FAST_EXECUTION_GUIDANCE.includes("ReadMany/SearchAndRead") || (FAST_EXECUTION_GUIDANCE.includes("ReadMany") && FAST_EXECUTION_GUIDANCE.includes("SearchAndRead")));
  assert.ok(FAST_EXECUTION_GUIDANCE.includes("focused test"));
  assert.ok(FAST_EXECUTION_GUIDANCE.includes("unchanged passing evidence"));
  assert.ok(FAST_EXECUTION_GUIDANCE.includes("no automatic command skipping") || FAST_EXECUTION_GUIDANCE.includes("No automatic command skipping"));
  assert.ok(FAST_EXECUTION_GUIDANCE.includes("gates"));
  assert.ok(FAST_EXECUTION_GUIDANCE.includes("serialized") || FAST_EXECUTION_GUIDANCE.includes("Serialize"));
});
