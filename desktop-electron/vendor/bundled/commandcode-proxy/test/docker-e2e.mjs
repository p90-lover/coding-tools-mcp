#!/usr/bin/env node

/**
 * Docker E2E test — spins up a mock CommandCode backend on the host,
 * runs the proxy in a Docker container pointed at it, and exercises
 * every endpoint with real HTTP requests.
 *
 * Usage: node test/docker-e2e.mjs
 */

import http from "node:http";
import { execSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";

const API_KEY = "e2e-test-" + randomUUID();
const PROXY_PORT = 38787;
const CONTAINER = "cc-proxy-e2e-" + Date.now();

let mockServer;
let mockPort;
let failures = 0;
let passes = 0;

function hostIP() {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal && iface.address !== "127.0.0.1") {
        return iface.address;
      }
    }
  }
  return "172.17.0.1";
}

function req(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://127.0.0.1:${PROXY_PORT}`);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    };
    const r = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    r.on("error", reject);
    if (opts.body) r.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    r.end();
  });
}

function assert(cond, msg) {
  if (cond) { passes++; console.log("  PASS: " + msg); }
  else { failures++; console.error("  FAIL: " + msg); }
}

async function startMock() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.url.includes("/alpha/whoami")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ user: { email: "docker-e2e@test.com" } }));
          return;
        }
        if (req.url.includes("/alpha/billing/credits")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ credits: { remaining: 42 } }));
          return;
        }
        if (req.url.includes("/alpha/generate")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          const events = [
            JSON.stringify({ type: "text-delta", text: "Docker " }),
            JSON.stringify({ type: "text-delta", text: "E2E " }),
            JSON.stringify({ type: "text-delta", text: "works!" }),
            JSON.stringify({ type: "finish-step", usage: { inputTokens: 10, outputTokens: 3 }, finishReason: "stop", response: { modelId: "deepseek/deepseek-v4-pro" } }),
            JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 3 } }),
          ];
          res.end(events.join("\n") + "\n");
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });
    mockServer.listen(0, "0.0.0.0", () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
}

async function startContainer() {
  const ip = hostIP();
  const cmd = [
    "docker", "run", "-d",
    "--name", CONTAINER,
    "--add-host=host.docker.internal:host-gateway",
    "-p", `${PROXY_PORT}:8787`,
    "-e", `PROXY_API_KEY=${API_KEY}`,
    "-e", `CC_API_KEY=fake-cc-key`,
    "-e", `CC_API_BASE=http://host.docker.internal:${mockPort}`,
    "commandcode-proxy:e2e",
  ];
  execSync(cmd.join(" "), { stdio: "pipe" });
  // Wait for container to be ready
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await req("/health");
      if (res.status === 200) return;
    } catch {}
  }
  throw new Error("Container did not start in time");
}

function cleanup() {
  try { execSync(`docker rm -f ${CONTAINER}`, { stdio: "pipe" }); } catch {}
  if (mockServer) mockServer.close();
}

async function run() {
  console.log("\n=== Docker E2E Tests ===\n");

  console.log("Starting mock CC backend...");
  await startMock();
  console.log("Mock backend on port " + mockPort);

  console.log("Starting Docker container...");
  await startContainer();
  console.log("Proxy container running on port " + PROXY_PORT + "\n");

  // --- Test 1: Health endpoint ---
  console.log("[1] Health endpoint");
  const health = await req("/health");
  assert(health.status === 200, "GET /health returns 200");
  assert(health.json.status === "ok", "status is 'ok'");
  assert(health.json.proxy === "commandcode-proxy", "proxy name correct");
  assert(health.json.user?.email === "docker-e2e@test.com", "user from mock backend");
  assert(health.json.credits?.remaining === 42, "credits from mock backend");

  // --- Test 2: HEAD / ---
  console.log("\n[2] HEAD /");
  const head = await req("/", { method: "HEAD" });
  assert(head.status === 200, "HEAD / returns 200");

  // --- Test 3: Auth rejection ---
  console.log("\n[3] Authentication");
  const noAuth = await req("/v1/models");
  assert(noAuth.status === 401, "rejects without API key");

  const wrongAuth = await req("/v1/models", { headers: { Authorization: "Bearer wrong" } });
  assert(wrongAuth.status === 401, "rejects wrong API key");

  const goodAuth = await req("/v1/models", { headers: { Authorization: `Bearer ${API_KEY}` } });
  assert(goodAuth.status === 200, "accepts correct API key");

  const xApiKey = await req("/v1/models", { headers: { "x-api-key": API_KEY } });
  assert(xApiKey.status === 200, "accepts x-api-key header");

  // --- Test 4: Models list ---
  console.log("\n[4] GET /v1/models");
  const models = await req("/v1/models", { headers: { Authorization: `Bearer ${API_KEY}` } });
  assert(models.json.object === "list", "returns list object");
  assert(models.json.data.length > 10, "has 10+ models");
  const modelIds = models.json.data.map((m) => m.id);
  assert(modelIds.includes("deepseek/deepseek-v4-pro"), "includes deepseek-v4-pro");
  assert(modelIds.includes("claude-sonnet-4-6"), "includes claude-sonnet-4-6");

  // --- Test 5: OpenAI chat completions (non-streaming) ---
  console.log("\n[5] POST /v1/chat/completions (non-streaming)");
  const chat = await req("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: {
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    },
  });
  assert(chat.status === 200, "returns 200");
  assert(chat.json.object === "chat.completion", "object is chat.completion");
  assert(chat.json.choices[0].message.role === "assistant", "role is assistant");
  assert(chat.json.choices[0].message.content === "Docker E2E works!", "content from mock");
  assert(chat.json.choices[0].finish_reason === "stop", "finish_reason is stop");
  assert(chat.json.usage.prompt_tokens === 10, "prompt_tokens correct");
  assert(chat.json.usage.completion_tokens === 3, "completion_tokens correct (actually outputTokens)");

  // --- Test 6: OpenAI chat completions (streaming) ---
  console.log("\n[6] POST /v1/chat/completions (streaming)");
  const chatStream = await req("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: {
      model: "deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    },
  });
  assert(chatStream.status === 200, "returns 200");
  assert(chatStream.headers["content-type"].includes("text/event-stream"), "content-type is SSE");
  assert(chatStream.body.includes("data:"), "body has SSE data lines");
  assert(chatStream.body.includes("[DONE]"), "body ends with [DONE]");
  assert(chatStream.body.includes("Docker"), "streamed content includes 'Docker'");

  // --- Test 7: Anthropic messages (non-streaming) ---
  console.log("\n[7] POST /v1/messages (non-streaming)");
  const msg = await req("/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      stream: false,
    },
  });
  assert(msg.status === 200, "returns 200");
  assert(msg.json.type === "message", "type is message");
  assert(msg.json.role === "assistant", "role is assistant");
  assert(msg.json.model === "claude-sonnet-4-6", "preserves claude model name");
  assert(msg.json.content[0].type === "text", "content block is text");
  assert(msg.json.content[0].text === "Docker E2E works!", "content from mock");
  assert(msg.json.stop_reason === "end_turn", "stop_reason is end_turn");

  // --- Test 8: Anthropic messages (streaming) ---
  console.log("\n[8] POST /v1/messages (streaming)");
  const msgStream = await req("/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      stream: true,
    },
  });
  assert(msgStream.status === 200, "returns 200");
  assert(msgStream.headers["content-type"].includes("text/event-stream"), "content-type is SSE");
  assert(msgStream.body.includes("event: message_start"), "has message_start event");
  assert(msgStream.body.includes("event: content_block_start"), "has content_block_start");
  assert(msgStream.body.includes("event: content_block_delta"), "has content_block_delta");
  assert(msgStream.body.includes("event: message_stop"), "has message_stop event");
  assert(msgStream.body.includes("Docker"), "streamed content includes 'Docker'");

  // --- Test 9: CORS ---
  console.log("\n[9] CORS");
  const options = await req("/v1/messages", { method: "OPTIONS" });
  assert(options.status === 204, "OPTIONS returns 204");
  const cors = await req("/");
  assert(cors.headers["access-control-allow-origin"] === "*", "CORS origin is *");

  // --- Test 10: 404 ---
  console.log("\n[10] Unknown routes");
  const notFound = await req("/v1/nonexistent", { headers: { Authorization: `Bearer ${API_KEY}` } });
  assert(notFound.status === 404, "returns 404 for unknown path");

  // --- Test 11: Model routing ---
  console.log("\n[11] Model routing (GPT -> default)");
  const gptChat = await req("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "test" }],
      stream: false,
    },
  });
  assert(gptChat.status === 200, "GPT model request succeeds");
  assert(gptChat.json.choices[0].message.content === "Docker E2E works!", "routes through successfully");

  // --- Test 12: /v1/v1/messages path normalization ---
  console.log("\n[12] Path normalization (/v1/v1/messages)");
  const doubleV1 = await req("/v1/v1/messages", {
    method: "POST",
    headers: { "x-api-key": API_KEY },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "test" }],
      max_tokens: 1024,
      stream: false,
    },
  });
  assert(doubleV1.status === 200, "/v1/v1/messages normalizes and works");

  // --- Test 13: Docker healthcheck ---
  console.log("\n[13] Docker healthcheck");
  const inspect = execSync(`docker inspect --format='{{.State.Health.Status}}' ${CONTAINER}`, { encoding: "utf8" }).trim();
  assert(inspect === "healthy" || inspect === "starting", `container health is '${inspect}'`);

  // --- Test 14: Container logs ---
  console.log("\n[14] Container logs (no leaked secrets)");
  const logs = execSync(`docker logs ${CONTAINER} 2>&1`, { encoding: "utf8" });
  assert(!logs.includes(API_KEY), "logs do not contain full API key");
  assert(logs.includes("Listening"), "logs show startup message");
  assert(logs.includes("Auth: ENABLED"), "logs show auth enabled");

  // --- Summary ---
  console.log("\n=== Results ===");
  console.log(`  ${passes} passed, ${failures} failed\n`);
  cleanup();
  process.exit(failures > 0 ? 1 : 0);
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled error:", err);
  cleanup();
  process.exit(1);
});

run().catch((err) => {
  console.error("Fatal:", err);
  cleanup();
  process.exit(1);
});
