import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = 18787;
const API_KEY = "test-key-" + randomUUID();

let proxyProcess;
let baseUrl;

function request(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    };
    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

function requestSSE(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    };
    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

let mockCCServer;
let lastCCRequest;

async function startMockCC() {
  return new Promise((resolve) => {
    mockCCServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString();
        let body = {};
        try { body = JSON.parse(bodyStr); } catch {}
        lastCCRequest = { method: req.method, url: req.url, headers: req.headers, body };

        if (req.url.includes("/alpha/whoami")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ user: { email: "test@example.com" } }));
          return;
        }
        if (req.url.includes("/alpha/billing/credits")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ credits: { remaining: 100 } }));
          return;
        }
        if (req.url.includes("/alpha/generate")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          const events = [
            JSON.stringify({ type: "text-delta", text: "Hello " }),
            JSON.stringify({ type: "text-delta", text: "world!" }),
            JSON.stringify({ type: "finish-step", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop", response: { modelId: "deepseek/deepseek-v4-pro" } }),
            JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 5 } }),
          ];
          res.end(events.join("\n") + "\n");
          return;
        }
        res.writeHead(404);
        res.end("Not found");
      });
    });
    mockCCServer.listen(0, "127.0.0.1", () => {
      resolve(mockCCServer.address().port);
    });
  });
}

async function startProxy(ccPort) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    proxyProcess = spawn("node", ["proxy.mjs"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PROXY_PORT: String(PORT),
        PROXY_HOST: "127.0.0.1",
        PROXY_API_KEY: API_KEY,
        CC_API_KEY: "fake-cc-key",
        CC_API_BASE: "http://127.0.0.1:" + ccPort,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let started = false;
    proxyProcess.stdout.on("data", (d) => {
      if (!started && d.toString().includes("Listening")) {
        started = true;
        resolve();
      }
    });
    proxyProcess.stderr.on("data", (d) => {
      const msg = d.toString();
      if (!started && msg.includes("FATAL")) {
        reject(new Error(msg));
      }
    });
    proxyProcess.on("error", reject);
    setTimeout(() => { if (!started) { started = true; resolve(); } }, 3000);
  });
}

describe("CommandCode Proxy", () => {
  before(async () => {
    const ccPort = await startMockCC();
    baseUrl = "http://127.0.0.1:" + PORT;
    await startProxy(ccPort);
  });

  after(() => {
    if (proxyProcess) proxyProcess.kill("SIGTERM");
    if (mockCCServer) mockCCServer.close();
  });

  beforeEach(() => {
    lastCCRequest = null;
  });

  describe("Health & Info", () => {
    it("GET / returns status ok", async () => {
      const res = await request("/");
      assert.equal(res.status, 200);
      assert.equal(res.json.status, "ok");
      assert.equal(res.json.proxy, "commandcode-proxy");
      assert.ok(res.json.endpoints);
      assert.ok(res.json.endpoints.openai_chat);
      assert.ok(res.json.endpoints.anthropic_messages);
    });

    it("GET /health returns status ok", async () => {
      const res = await request("/health");
      assert.equal(res.status, 200);
      assert.equal(res.json.status, "ok");
    });

    it("HEAD / returns 200", async () => {
      const res = await request("/", { method: "HEAD" });
      assert.equal(res.status, 200);
    });
  });

  describe("Authentication", () => {
    it("rejects requests without API key", async () => {
      const res = await request("/v1/models");
      assert.equal(res.status, 401);
      assert.ok(res.json.error);
    });

    it("rejects requests with wrong API key", async () => {
      const res = await request("/v1/models", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      assert.equal(res.status, 401);
    });

    it("accepts requests with correct Bearer token", async () => {
      const res = await request("/v1/models", {
        headers: { Authorization: "Bearer " + API_KEY },
      });
      assert.equal(res.status, 200);
    });

    it("accepts requests with x-api-key header", async () => {
      const res = await request("/v1/models", {
        headers: { "x-api-key": API_KEY },
      });
      assert.equal(res.status, 200);
    });

    it("does not require auth on / and /health", async () => {
      const r1 = await request("/");
      assert.equal(r1.status, 200);
      const r2 = await request("/health");
      assert.equal(r2.status, 200);
    });
  });

  describe("GET /v1/models", () => {
    it("returns model list", async () => {
      const res = await request("/v1/models", {
        headers: { Authorization: "Bearer " + API_KEY },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "list");
      assert.ok(Array.isArray(res.json.data));
      assert.ok(res.json.data.length > 0);
      const ids = res.json.data.map((m) => m.id);
      assert.ok(ids.includes("deepseek/deepseek-v4-pro"));
    });
  });

  describe("POST /v1/chat/completions (OpenAI)", () => {
    it("returns non-streaming completion", async () => {
      const res = await request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY },
        body: {
          model: "deepseek/deepseek-v4-pro",
          messages: [{ role: "user", content: "Say hello" }],
          stream: false,
        },
      });
      assert.equal(res.status, 200);
      assert.ok(res.json.id);
      assert.equal(res.json.object, "chat.completion");
      assert.ok(res.json.choices);
      assert.equal(res.json.choices[0].message.role, "assistant");
      assert.equal(res.json.choices[0].message.content, "Hello world!");
    });

    it("returns streaming completion", async () => {
      const res = await requestSSE("/v1/chat/completions", {
        headers: { Authorization: "Bearer " + API_KEY },
        body: {
          model: "deepseek/deepseek-v4-pro",
          messages: [{ role: "user", content: "Say hello" }],
          stream: true,
        },
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"].includes("text/event-stream"));
      assert.ok(res.body.includes("data:"));
      assert.ok(res.body.includes("[DONE]"));
    });

    it("forwards correct headers to CC API", async () => {
      await request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY },
        body: {
          model: "deepseek/deepseek-v4-pro",
          messages: [{ role: "user", content: "test" }],
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      assert.ok(lastCCRequest.headers["authorization"]);
      assert.ok(lastCCRequest.headers["x-command-code-version"]);
    });
  });

  describe("POST /v1/messages (Anthropic)", () => {
    it("returns non-streaming message", async () => {
      const res = await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
        body: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "Say hello" }],
          max_tokens: 1024,
          stream: false,
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.type, "message");
      assert.equal(res.json.role, "assistant");
      assert.ok(res.json.content);
      assert.ok(res.json.content.length > 0);
    });

    it("returns streaming message", async () => {
      const res = await requestSSE("/v1/messages", {
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
        body: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "Say hello" }],
          max_tokens: 1024,
          stream: true,
        },
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"].includes("text/event-stream"));
      assert.ok(res.body.includes("message_start"));
      assert.ok(res.body.includes("message_stop"));
    });

    it("remaps Claude models to default model", async () => {
      await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1024,
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      const model = lastCCRequest.body.params.model;
      assert.equal(model, "deepseek/deepseek-v4-pro");
    });

    it("preserves original model name in response", async () => {
      const res = await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1024,
          stream: false,
        },
      });
      assert.equal(res.json.model, "claude-sonnet-4-6");
    });

    it("handles /v1/v1/messages path normalization", async () => {
      const res = await request("/v1/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1024,
          stream: false,
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.type, "message");
    });
  });

  describe("CORS", () => {
    it("responds to OPTIONS with 204", async () => {
      const res = await request("/v1/messages", { method: "OPTIONS" });
      assert.equal(res.status, 204);
    });

    it("sets CORS headers", async () => {
      const res = await request("/");
      assert.equal(res.headers["access-control-allow-origin"], "*");
    });
  });

  describe("Error Handling", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await request("/v1/unknown", {
        headers: { Authorization: "Bearer " + API_KEY },
      });
      assert.equal(res.status, 404);
    });
  });

  describe("Model Routing", () => {
    it("routes GPT models to default CC model", async () => {
      await request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY },
        body: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "test" }],
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      assert.equal(lastCCRequest.body.params.model, "deepseek/deepseek-v4-pro");
    });

    it("passes through gateway models unchanged", async () => {
      await request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY },
        body: {
          model: "moonshotai/Kimi-K2.5",
          messages: [{ role: "user", content: "test" }],
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      assert.equal(lastCCRequest.body.params.model, "moonshotai/Kimi-K2.5");
    });
  });

  describe("Tool Conversion", () => {
    it("converts OpenAI tool format to CC format", async () => {
      await request("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + API_KEY },
        body: {
          model: "deepseek/deepseek-v4-pro",
          messages: [{ role: "user", content: "test" }],
          tools: [{
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          }],
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      const tools = lastCCRequest.body.params.tools;
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "get_weather");
      assert.ok(tools[0].input_schema);
    });
  });

  describe("Anthropic Message Conversion", () => {
    it("converts Anthropic system prompt", async () => {
      await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: {
          model: "claude-sonnet-4-6",
          system: "You are a pirate.",
          messages: [{ role: "user", content: "Ahoy!" }],
          max_tokens: 1024,
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      assert.equal(lastCCRequest.body.params.system, "You are a pirate.");
    });

    it("handles array system prompt", async () => {
      await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: {
          model: "claude-sonnet-4-6",
          system: [{ type: "text", text: "Be helpful." }],
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1024,
          stream: false,
        },
      });
      assert.ok(lastCCRequest);
      assert.equal(lastCCRequest.body.params.system, "Be helpful.");
    });

    it("filters non-custom tool types", async () => {
      await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: {
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1024,
          stream: false,
          tools: [
            { name: "web_search_tool", type: "web_search_20250305", input_schema: {} },
            { name: "my_tool", type: "custom", description: "A tool", input_schema: { type: "object" } },
          ],
        },
      });
      assert.ok(lastCCRequest);
      const tools = lastCCRequest.body.params.tools;
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, "my_tool");
    });
  });
});
