"use strict";
require("./support/temp-dirs.cjs");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createChatImageGenerator, IMAGE_TOOL_DEFS, imageRequest } = require("../electron/chat-images.cjs");
const { createChatAgentTools } = require("../electron/chat-agent-tools.cjs");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=";
const connection = () => ({ baseUrl: "http://127.0.0.1:8317", proxyApiKey: "PRIVATE_IMAGE_FIXTURE_KEY" });
const imageReply = () => Response.json({ data: [{ b64_json: PNG }] });

function fixture(fetchImpl, options = {}) {
  const requests = [];
  const generate = createChatImageGenerator({ connection, ...options, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), ...init, json: JSON.parse(init.body) });
    return fetchImpl ? fetchImpl(url, init) : imageReply();
  } });
  return { requests, generate };
}

test("image generation uses the standalone image model without the parent chat's xhigh", async () => {
  const parent = Object.freeze({ model: "gpt-6.1-sol", effort: "xhigh" });
  const { requests, generate } = fixture();
  const result = await generate({ prompt: "A small green square" });
  assert.deepEqual(result, { data: PNG, mimeType: "image/png", model: "gpt-image-2" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:8317/v1/images/generations");
  assert.equal(requests[0].redirect, "manual");
  assert.deepEqual(requests[0].json, { model: "gpt-image-2", prompt: "A small green square", size: "1024x1024", quality: "auto", n: 1, response_format: "b64_json" });
  assert.equal(parent.effort, "xhigh");
  assert.equal(requests[0].headers.Authorization, "Bearer PRIVATE_IMAGE_FIXTURE_KEY");
  assert.ok(!IMAGE_TOOL_DEFS[0].inputSchema.properties.effort);
  assert.equal(IMAGE_TOOL_DEFS[0].annotations.idempotentHint, false);
});

test("image parameters are separate from reasoning: no effort suffix, inherited fields, or arbitrary endpoint", async () => {
  const { requests, generate } = fixture();
  for (const args of [
    { prompt: "p", effort: "xhigh" }, { prompt: "p", complexity: "xhigh" },
    { prompt: "p", reasoning: { effort: "xhigh" } }, { prompt: "p", reasoning_effort: "xhigh" },
    { prompt: "p", model: "gpt-6.1-sol" }, { prompt: "p", model: "gpt-image-2(xhigh)" },
    { prompt: "p", url: "https://untrusted.invalid" }, { prompt: "p", n: 2 },
    { prompt: "" }, { prompt: " " }, { prompt: "p".repeat(12001) },
    { prompt: "p", size: "invalid" }, { prompt: "p", quality: "xhigh" }, [], null,
  ]) await assert.rejects(() => generate(args), error => error.executionStatus === "not_started");
  assert.equal(requests.length, 0);
  assert.deepEqual(imageRequest({ prompt: "p", quality: "high", size: "1536x1024", model: "gpt-image-2.6-flare" }),
    { prompt: "p", quality: "high", size: "1536x1024", model: "gpt-image-2.6-flare", n: 1, response_format: "b64_json" });
});

test("configured endpoints preserve their base path without duplicating v1", async () => {
  for (const [baseUrl, expected] of [
    ["http://127.0.0.1:8317/", "http://127.0.0.1:8317/v1/images/generations"],
    ["http://127.0.0.1:8317/v1", "http://127.0.0.1:8317/v1/images/generations"],
    ["https://configured.example/proxy/v1/", "https://configured.example/proxy/v1/images/generations"],
  ]) {
    const { requests, generate } = fixture(null, { connection: () => ({ ...connection(), baseUrl }) });
    await generate({ prompt: "p" });
    assert.equal(requests[0].url, expected);
  }
  for (const baseUrl of ["http://untrusted.invalid", "https://user:password@configured.example", "https://configured.example/?key=secret"]) {
    const { requests, generate } = fixture(null, { connection: () => ({ ...connection(), baseUrl }) });
    await assert.rejects(() => generate({ prompt: "p" }));
    assert.equal(requests.length, 0);
  }
});

test("missing CPA cannot silently use another account or endpoint", async () => {
  const { requests, generate } = fixture(null, { connection: () => null });
  await assert.rejects(() => generate({ prompt: "p" }), /Start CPA/);
  assert.equal(requests.length, 0);
});

test("a rejected image or redirect is not retried and cannot expose provider credentials", async () => {
  for (const status of [302, 400, 401, 429, 502]) {
    const { requests, generate } = fixture(() => Response.json({ error: { message: "PRIVATE_IMAGE_FIXTURE_KEY" } }, { status }));
    await assert.rejects(() => generate({ prompt: "p" }), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.ok(!error.message.includes("PRIVATE_IMAGE_FIXTURE_KEY"));
      assert.equal(error.executionStatus, "failed");
      return true;
    });
    assert.equal(requests.length, 1);
  }
});

test("an ambiguous connection failure or timeout cannot replay a billable image request", async () => {
  const { requests, generate } = fixture(() => { throw new Error("PRIVATE_IMAGE_FIXTURE_KEY"); });
  await assert.rejects(() => generate({ prompt: "p" }), error => {
    assert.equal(error.executionStatus, "unknown");
    assert.match(error.message, /not retried/);
    assert.ok(!error.message.includes("PRIVATE_IMAGE_FIXTURE_KEY"));
    return true;
  });
  assert.equal(requests.length, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => generate({ prompt: "p" }, { signal: abort.signal }));
  assert.equal(requests.length, 1, "cancellation before the call sends nothing");
  const pending = fixture((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), { timeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(() => pending.generate({ prompt: "p" }), error => error.executionStatus === "unknown");
    assert.equal(pending.requests.length, 1);
  } finally { clearTimeout(keepAlive); }
});

test("provider image bytes are bounded and validated; URL images are never fetched", async () => {
  for (const reply of ["not JSON", JSON.stringify({ data: [{ url: "http://127.0.0.1/private" }] }),
    JSON.stringify({ data: [{ b64_json: Buffer.from("<svg>unsafe</svg>").toString("base64") }] }),
    JSON.stringify({ data: [{ b64_json: "invalid!" }] })]) {
    const { requests, generate } = fixture(() => new Response(reply));
    await assert.rejects(() => generate({ prompt: "p" }), error => error.executionStatus === "failed");
    assert.equal(requests.length, 1);
  }
  let cancelled = false;
  const large = fixture(() => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(25 * 1024 * 1024)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(() => large.generate({ prompt: "p" }), /size limit/);
  assert.equal(cancelled, true);
});

test("the MCP image tool returns the generated image, not a prompt, and respects session isolation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-images-"));
  const requests = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push({ path: request.url, body: parsed });
    response.setHeader("Content-Type", "application/json");
    if (parsed.prompt === "fail") {
      response.statusCode = 502;
      response.end(JSON.stringify({ error: { message: "PRIVATE_IMAGE_FIXTURE_KEY" } }));
    } else response.end(JSON.stringify({ data: [{ b64_json: PNG }] }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const generateImage = createChatImageGenerator({ connection: () => ({ ...connection(), baseUrl: `http://127.0.0.1:${upstream.address().port}` }) });
  let enabled = true;
  const tools = createChatAgentTools({
    enabled: () => enabled, generateImage, logger: { info() {}, warn() {} },
    sessionWorkspace: async () => ({ root }),
    requestHeadless: async endpoint => endpoint === "/api/v1/workspaces" ? { ok: true, workspaces: [{ id: "ws1", path: root }] }
      : { ok: true, tools: [] },
  });
  let lease;
  try {
    lease = await tools.lease({ agent: "claude-code", workspaceId: "ws1" });
    lease.bind("image-session");
    const server = lease.servers[0];
    const rpc = async (method, params = {}) => (await (await fetch(server.url, { method: "POST",
      headers: { ...server.headers, "Content-Type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })).json()).result;
    const catalog = await rpc("tools/list");
    assert.equal(catalog.tools.filter(tool => tool.name === "generate_image").length, 1);
    const result = await rpc("tools/call", { name: "generate_image", arguments: { prompt: "A green square" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content[0], { type: "image", data: PNG, mimeType: "image/png" });
    assert.equal(requests[0].path, "/v1/images/generations");
    assert.equal(requests[0].body.reasoning, undefined);
    assert.equal(requests[0].body.complexity, undefined);
    assert.deepEqual(fs.readdirSync(root), [], "the image is returned inline without disk storage");
    const failed = await rpc("tools/call", { name: "generate_image", arguments: { prompt: "fail" } });
    assert.equal(failed.isError, true);
    assert.ok(!JSON.stringify(failed).includes("PRIVATE_IMAGE_FIXTURE_KEY"));
    assert.equal(failed.structuredContent.error.safe_to_retry, false);
    assert.equal(failed.structuredContent.error.execution_status, "failed");
    enabled = false;
    assert.equal((await rpc("tools/call", { name: "generate_image", arguments: { prompt: "p" } })).isError, true);
    assert.equal(requests.length, 2);
  } finally {
    lease?.release();
    await tools.close();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
