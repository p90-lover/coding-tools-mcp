"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

// Seen live 2026-11-15: with the Codex accounts out of quota, CPA served the chat's model
// (gpt-6-astra) from an OpenAI API key. Auto Review answered 503, so "Let the model judge" asked the
// chat's own model, which answered HTTP 400 "Unsupported parameter: 'max_tokens' ... Use
// 'max_completion_tokens' instead" (CPA sends max_completion_tokens on as max_tokens too), then
// "'temperature' does not support 0". Every request was denied unjudged.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createAgentOrchestratorWorkflow: createWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const route = { harness_id: "ao:claude-code", provider_id: "agent-orchestrator", account_id: "ao-local", model: "cpa/test-model",
  permission_profile: ":ao-default", native_permission_profile: ":workspace", approval_policy: "on-request", approvals_reviewer: "auto_review" };
const decisions = [{ id: "yes", kind: "allow_once" }, { id: "no", kind: "reject_once" }];
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
// Waits by the clock, not by a count of pauses: a review no model answers is tried 3 times, 4 s apart
// (REVIEW_TRIES, REVIEW_RETRY_MS), so the denial comes about 8 s in. 600 pauses lasted 9.4 s on
// Windows' coarse timers but 7.9 s on a CI runner, which gave up just before the third try.
const until = async (done, ms = 20_000) => { for (const end = Date.now() + ms; !done() && Date.now() < end;) await pause(); };
// The OpenAI API's own answers, as CPA passed them on.
const refusals = {
  max_tokens: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: "invalid_request_error", param: "max_tokens", code: "unsupported_parameter" } },
  temperature: { error: { message: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
    type: "invalid_request_error", param: "temperature", code: "unsupported_value" } },
};
const answer = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

/** A judged "Approve for me" chat whose requests come one after another; `model(body)` answers the chat's model. */
function chat(commands, model) {
  const requests = commands.map((command, index) => ({ approval_id: `request-${index}`, source: "ao", kind: "command", tool: "PowerShell", command, decisions }));
  const mission = { id: "run", workspace_id: "ws", revision: 3, execution_mode: "single", grant: { executable_sha256: "a".repeat(64) },
    nodes: [{ id: "one", role: "planner", state: "running", parents: [], route, receipt: { thread_id: "s", request_key: "k", turn_id: "t" } }] };
  const resolved = [], bodies = [], logged = [];
  const workflow = createWorkflow({
    findCodexExecutable: () => process.execPath,
    resolveHarness: async () => ({ executable: process.execPath, expected_sha256: "a".repeat(64) }),
    cpaConnection: () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "k" }),
    logger: { info: (event, detail) => logged.push([event, detail]), warn: () => {} },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/models")) return { ok: true, json: async () => ({ data: [{ id: "test-model" }, { id: "codex-auto-review" }] }) };
      const body = JSON.parse(init.body);
      // CPA Auto Review is out of quota: it cannot answer at all.
      if (body.model === "codex-auto-review") return answer(503, { error: { message: "None of the 2 review accounts could complete the review" } });
      bodies.push(body);
      return model(body);
    },
    requestHeadless: async endpoint => endpoint.endsWith("/read") ? { ok: true, runs: [mission], worker_capacity: { run: 1 } } : { ok: true, run: mission },
    aoHarness: {
      observe: async () => ({ status: "working", turnId: "t", turnState: "running", lastActivityAt: Date.now(), timeline: [],
        approvals: requests.slice(resolved.length, resolved.length + 1), needsInput: true }),
      resolveApproval: async (_session, id, decision) => { resolved.push([id, decision]); return { ok: true }; },
      interrupt: async () => {},
    },
    confirm: async () => true,
  });
  return { workflow, mission, resolved, bodies, logged };
}

/** The chat's model as the OpenAI API served it: no max_tokens (nor max_completion_tokens), no temperature 0. */
function strictModel(body) {
  if ("max_tokens" in body || "max_completion_tokens" in body) return answer(400, refusals.max_tokens);
  if ("temperature" in body && body.temperature !== 1) return answer(400, refusals.temperature);
  return answer(200, { choices: [{ message: { content: JSON.stringify({ outcome: "allow", rationale: "a feature-branch push the user asked for" }) } }] });
}

test("the judge leaves out the settings the chat's model refuses, judges, and remembers them for that model", async () => {
  const { workflow, mission, resolved, bodies, logged } = chat(["git -C ../one push origin feat/a", "git -C ../two push origin feat/b"], strictModel);
  await workflow.call("chat_model_judges", { enabled: true, meteredReviews: true }); // reviews through CPA are opt-in since 0.8.122
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    await until(() => resolved.length >= 2);
    assert.deepEqual(resolved, [["request-0", "yes"], ["request-1", "yes"]], "both requests were judged, not denied unjudged");
    // The first review learned the model's limits one refusal at a time; the second asked once.
    const shapes = bodies.map((body) => ["max_tokens", "max_completion_tokens", "temperature"].filter((name) => name in body).join("+") || "none");
    assert.deepEqual(shapes, ["max_tokens+temperature", "temperature", "none", "none"]);
    assert.ok(bodies.every((body) => body.model === "test-model" && body.messages?.[0]?.content), "the same model and request each time");
    assert.deepEqual(logged.filter(([event]) => event === "ao.model_param_refused").map(([, detail]) => detail.param), ["max_tokens", "temperature"]);
  } finally { mission.nodes[0].state = "finished"; }
});

test("a 400 that names no optional setting is not retried: the judge reports it as before", async () => {
  const refuse = () => answer(400, { error: { message: "Unsupported parameter: 'messages' is malformed", param: "messages", code: "unsupported_parameter" } });
  const { workflow, mission, resolved, bodies } = chat(["git -C ../one push origin feat/a"], refuse);
  await workflow.call("chat_model_judges", { enabled: true, meteredReviews: true }); // reviews through CPA are opt-in since 0.8.122
  try {
    await workflow.call("start_run", { workspaceId: "ws", runId: "run" });
    await until(() => resolved.length > 0);
    assert.deepEqual(resolved, [["request-0", "no"]], "with the judge on, an unanswerable review still denies, unjudged");
    assert.ok(bodies.length >= 1 && bodies.every((body) => "max_tokens" in body && "temperature" in body), "nothing was left out");
    assert.ok(bodies.length <= 3, `one call per review try, not a loop (${bodies.length})`);
  } finally { mission.nodes[0].state = "finished"; }
});
