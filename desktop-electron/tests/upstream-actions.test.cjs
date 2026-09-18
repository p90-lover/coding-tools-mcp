"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const {
  ALLOWED_ANNEAL_POST,
  ALLOWED_PASEO,
  actUpstream,
  annealPathForOp,
  buildPaseoMessage,
} = require("../electron/upstream-actions.cjs");

test("Paseo send builds the original-function protocol v1 RPC", () => {
  const message = buildPaseoMessage({
    op: "send",
    agentId: "agent-1",
    text: "hello from coding tools",
    requestId: "req-1",
  });
  assert.equal(message.type, "send_agent_message_request");
  assert.equal(message.agentId, "agent-1");
  assert.equal(message.text, "hello from coding tools");
  assert.ok(ALLOWED_PASEO.includes(message.type));
  assert.throws(() => buildPaseoMessage({ op: "delete_everything", agentId: "agent-1" }), /allowlist/i);
});

test("Anneal start posts the allowlisted original-function path", async () => {
  const spec = annealPathForOp("start", "task-9");
  assert.equal(spec.pattern, "/tasks/{id}/start");
  assert.equal(spec.path, "/tasks/task-9/start");
  assert.ok(ALLOWED_ANNEAL_POST.includes(spec.pattern));

  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/tasks/task-9/start");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await actUpstream({
      toolId: "anneal",
      op: "start",
      taskId: "task-9",
      endpoint: `http://127.0.0.1:${port}/`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.op, "start");
    assert.match(result.detail, /HTTP 200/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Anneal create posts BACKLOG to /projects/{id}/tasks and preview uses GET", async () => {
  const {
    ALLOWED_ANNEAL_GET,
    ALLOWED_ANNEAL_POST,
    actUpstream,
    annealPathForOp,
  } = require("../electron/upstream-actions.cjs");
  const spec = annealPathForOp("create", "proj-9", { title: "Handoff", description: "From Paseo review" });
  assert.equal(spec.method, "POST");
  assert.equal(spec.pattern, "/projects/{id}/tasks");
  assert.equal(spec.path, "/projects/proj-9/tasks");
  assert.equal(spec.body.status, "BACKLOG");
  assert.equal(spec.body.approvalGate, true);
  assert.equal(spec.body.opensPullRequest, false);
  assert.ok(ALLOWED_ANNEAL_POST.includes(spec.pattern));
  assert.ok(ALLOWED_ANNEAL_GET.includes("/tasks/{id}"));

  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      if (request.method === "POST") {
        const body = JSON.parse(raw || "{}");
        assert.equal(body.status, "BACKLOG");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "task-created" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "task-created", status: "BACKLOG" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const created = await actUpstream({
      toolId: "anneal",
      op: "create",
      projectId: "proj-9",
      title: "Handoff",
      endpoint: `http://127.0.0.1:${port}/`,
    });
    assert.equal(created.ok, true);
    assert.equal(created.body.id, "task-created");
    const preview = await actUpstream({
      toolId: "anneal",
      op: "preview",
      taskId: "task-created",
      endpoint: `http://127.0.0.1:${port}/`,
    });
    assert.equal(preview.body.status, "BACKLOG");
    assert.deepEqual(seen.map((entry) => `${entry.method} ${entry.url}`), [
      "POST /projects/proj-9/tasks",
      "GET /tasks/task-created",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Unknown or remote upstream actions are rejected", async () => {
  assert.throws(() => annealPathForOp("explode", "task-1"), /allowlist/i);
  await assert.rejects(
    () => actUpstream({
      toolId: "anneal",
      op: "start",
      taskId: "task-9",
      endpoint: "http://example.com:3000/",
    }),
    /loopback/i,
  );
});
