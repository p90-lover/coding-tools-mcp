"use strict";

const net = require("node:net");

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 2_500;
const LISTENING_STATUSES = new Set([200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 422, 429, 500, 502, 503]);

const FIVE_STACK_LOOPBACKS = Object.freeze({
  cpa: Object.freeze({
    id: "cpa",
    name: "CPA / CLIProxyAPI",
    role: "provider-backend",
    origin: "http://127.0.0.1:8317",
    port: 8317,
    probes: Object.freeze(["http://127.0.0.1:8317/v1/models"]),
    fallbackProbes: Object.freeze([]),
  }),
  "codex-router": Object.freeze({
    id: "codex-router",
    name: "Codex Router",
    role: "provider-backend",
    origin: "http://127.0.0.1:4202",
    port: 4202,
    probes: Object.freeze(["http://127.0.0.1:4202/"]),
    fallbackProbes: Object.freeze([]),
    callerKeyedModels: "/_codex-router/{callerKey}/v1/models",
  }),
  "commandcode-proxy": Object.freeze({
    id: "commandcode-proxy",
    name: "CommandCode Proxy",
    role: "proxy",
    origin: "http://127.0.0.1:9090",
    port: 9090,
    probes: Object.freeze([
      "http://127.0.0.1:9090/health",
      "http://127.0.0.1:9090/v1/models",
    ]),
    fallbackOrigin: "http://127.0.0.1:3050",
    fallbackPort: 3050,
    fallbackProbes: Object.freeze([
      "http://127.0.0.1:3050/health",
      "http://127.0.0.1:3050/v1/models",
    ]),
  }),
  paseo: Object.freeze({
    id: "paseo",
    name: "Paseo",
    role: "orchestrator",
    origin: "http://127.0.0.1:6768",
    port: 6768,
    protocol: "v1",
    probes: Object.freeze(["http://127.0.0.1:6768/"]),
    fallbackProbes: Object.freeze([]),
    execution: "ws://127.0.0.1:6768/ws",
  }),
  anneal: Object.freeze({
    id: "anneal",
    name: "Anneal",
    role: "task-preview",
    origin: "http://127.0.0.1:3000",
    port: 3000,
    probes: Object.freeze([
      "http://127.0.0.1:3000/tasks",
      "http://127.0.0.1:3000/",
    ]),
    fallbackProbes: Object.freeze([]),
    preview: "http://127.0.0.1:3000/#/tasks",
    posts: Object.freeze(["http://127.0.0.1:3000/tasks"]),
  }),
});

const STACK_IDS = Object.freeze(Object.keys(FIVE_STACK_LOOPBACKS));

const MCP_TOOLS = Object.freeze([
  Object.freeze({
    name: "five_stack_loopbacks",
    description: "Return the locked in-app five-stack loopback map used by Desktop and MCP.",
    readOnly: true,
  }),
  Object.freeze({
    name: "five_stack_status",
    description: "List listening/offline health of CPA :8317, Codex Router :4202, CommandCode :9090/:3050, Paseo :6768, and Anneal :3000.",
    readOnly: true,
  }),
  Object.freeze({
    name: "five_stack_start",
    description: "Reconnect or start one five-stack in-app loopback. Does not download or require a GitHub token.",
    readOnly: false,
  }),
]);

function publicLoopbackMap() {
  return Object.freeze({
    control_plane: "coding-tools-shell-mcp-loopbacks",
    lane: "hello-desktop-shell-mcp",
    loopbackOnly: true,
    stacks: Object.freeze(Object.fromEntries(STACK_IDS.map((id) => {
      const item = FIVE_STACK_LOOPBACKS[id];
      return [id, Object.freeze({
        id: item.id,
        name: item.name,
        role: item.role,
        origin: item.origin,
        port: item.port,
        probes: item.probes.slice(),
        ...(item.fallbackOrigin ? {
          fallbackOrigin: item.fallbackOrigin,
          fallbackPort: item.fallbackPort,
          fallbackProbes: item.fallbackProbes.slice(),
        } : {}),
        ...(item.execution ? { execution: item.execution, protocol: item.protocol } : {}),
        ...(item.preview ? { preview: item.preview, posts: item.posts.slice() } : {}),
        ...(item.callerKeyedModels ? { callerKeyedModels: item.callerKeyedModels } : {}),
      })];
    }))),
  });
}

function tcpListening(port, host = LOOPBACK_HOST, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function httpListening(status) {
  return Number.isInteger(status) && LISTENING_STATUSES.has(status);
}

async function probeUrl(url, {
  fetchImpl = globalThis.fetch,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { url, listening: false, statusCode: null, error: "fetch_unavailable" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json,text/html;q=0.8,*/*;q=0.1",
        ...headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const statusCode = Number(response.status) || null;
    return {
      url,
      listening: httpListening(statusCode),
      statusCode,
      error: null,
    };
  } catch (error) {
    const code = error?.cause?.code || error?.code || "";
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
      return { url, listening: false, statusCode: null, error: "connection_refused" };
    }
    if (error?.name === "AbortError") {
      return { url, listening: false, statusCode: null, error: "timeout" };
    }
    return {
      url,
      listening: false,
      statusCode: null,
      error: "probe_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeFirst(urls, options) {
  const results = [];
  for (const url of urls) {
    const result = await probeUrl(url, options);
    results.push(result);
    if (result.listening) return { hit: result, results };
  }
  return { hit: results[results.length - 1] || null, results };
}

function routerCallerProbe(callerKey) {
  const key = typeof callerKey === "string" ? callerKey.trim() : "";
  if (!key) return null;
  return `http://127.0.0.1:4202/_codex-router/${encodeURIComponent(key)}/v1/models`;
}

async function probeStack(id, {
  fetchImpl,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  callerKey = "",
  now = () => new Date().toISOString(),
} = {}) {
  const spec = FIVE_STACK_LOOPBACKS[id];
  if (!spec) throw new Error(`Unknown five-stack loopback: ${id}`);
  const tcp = await tcpListening(spec.port, LOOPBACK_HOST, Math.min(800, timeoutMs));
  const primary = await probeFirst(spec.probes, { fetchImpl, headers, timeoutMs });
  let fallbackUsed = false;
  let fallback = { hit: null, results: [] };
  if (!tcp && !primary.hit?.listening && spec.fallbackProbes?.length) {
    fallback = await probeFirst(spec.fallbackProbes, { fetchImpl, headers, timeoutMs });
    fallbackUsed = fallback.hit?.listening === true;
  }
  let callerKeyed = null;
  if (id === "codex-router") {
    const keyedUrl = routerCallerProbe(callerKey);
    if (keyedUrl) callerKeyed = await probeUrl(keyedUrl, { fetchImpl, headers, timeoutMs });
  }
  const listening = tcp
    || primary.hit?.listening === true
    || fallbackUsed
    || callerKeyed?.listening === true;
  const chosen = fallbackUsed ? fallback.hit : (primary.hit || callerKeyed);
  return Object.freeze({
    id: spec.id,
    name: spec.name,
    role: spec.role,
    origin: fallbackUsed ? spec.fallbackOrigin : spec.origin,
    port: fallbackUsed ? spec.fallbackPort : spec.port,
    listening,
    fallbackUsed,
    probeUrl: chosen?.url || spec.probes[0],
    statusCode: chosen?.statusCode ?? callerKeyed?.statusCode ?? null,
    error: listening ? null : (chosen?.error || "offline"),
    ...(spec.execution ? { execution: spec.execution, protocol: spec.protocol } : {}),
    ...(spec.preview ? { preview: spec.preview } : {}),
    checkedAt: now(),
  });
}

async function probeAll(options = {}) {
  const stacks = [];
  for (const id of STACK_IDS) {
    stacks.push(await probeStack(id, options));
  }
  return Object.freeze({
    generatedAt: options.now ? options.now() : new Date().toISOString(),
    loopbackOnly: true,
    downloadRequired: false,
    stacks: Object.freeze(stacks),
  });
}

function fingerprintStatus(snapshot) {
  return (snapshot?.stacks || []).map((stack) => [
    stack.id,
    stack.listening ? "1" : "0",
    stack.fallbackUsed ? "f" : "p",
    stack.statusCode ?? "",
    stack.error ?? "",
  ].join(":")).join("|");
}

function sanitizePublic(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizePublic(entry));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (/(?:^|_)(?:access_token|api_key|private_key|client_secret|password|secret|token|credential|bearer|authorization|caller_key|proxy_api_key|management_key)(?:_|$)/.test(normalized)
      && typeof entry !== "boolean") {
      continue;
    }
    next[key] = sanitizePublic(entry);
  }
  return next;
}

module.exports = {
  FIVE_STACK_LOOPBACKS,
  MCP_TOOLS,
  STACK_IDS,
  fingerprintStatus,
  probeAll,
  probeStack,
  publicLoopbackMap,
  sanitizePublic,
  tcpListening,
};
