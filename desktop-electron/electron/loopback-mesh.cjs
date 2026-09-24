"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MESH_SCHEMA_VERSION = 1;
const DEFAULT_IN_APP_LOOPBACKS = Object.freeze({
  "codex-router": Object.freeze({
    url: "http://127.0.0.1:4202",
    executionUrl: null,
    openaiBaseUrl: null,
    role: "router",
  }),
  "commandcode-proxy": Object.freeze({
    url: "http://127.0.0.1:9090",
    executionUrl: null,
    openaiBaseUrl: "http://127.0.0.1:9090/v1",
    anthropicBaseUrl: "http://127.0.0.1:9090/v1",
    role: "llm-proxy",
  }),
  cpa: Object.freeze({
    url: "http://127.0.0.1:8317",
    executionUrl: null,
    openaiBaseUrl: null,
    role: "provider-hub",
  }),
  paseo: Object.freeze({
    url: "http://127.0.0.1:6768",
    executionUrl: "ws://127.0.0.1:6768/ws",
    openaiBaseUrl: null,
    role: "agent-runtime",
  }),
  anneal: Object.freeze({
    url: "http://127.0.0.1:5173",
    executionUrl: "http://127.0.0.1:3000",
    openaiBaseUrl: null,
    role: "task-runtime",
  }),
});

function canonicalHost(value) {
  return String(value || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function originOf(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!LOOPBACK_HOSTS.has(canonicalHost(parsed.hostname))) {
    throw new Error(`${label} must use a loopback host`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  return `${parsed.protocol}//${parsed.host}`.replace(/\/$/, "");
}

function optionalLoopbackUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new URL(value);
  if (!LOOPBACK_HOSTS.has(canonicalHost(parsed.hostname))) {
    throw new Error(`${label} must use a loopback host`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  return parsed.toString();
}

function openaiBaseFrom(origin) {
  return `${origin.replace(/\/$/, "")}/v1`;
}

function httpOriginOfMaybeWs(value, label) {
  const rewritten = String(value || "").replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  return originOf(`${rewritten}/`, label);
}

function overlayLoopbackUrl(id, fallback, snapshotService) {
  const canonical = originOf(`${fallback.url}/`, `${id} url`);
  const snapshotEndpoint = snapshotService?.endpoint;
  if (typeof snapshotEndpoint !== "string" || !snapshotEndpoint.trim()) return canonical;
  const overlay = originOf(snapshotEndpoint, `${id} url`);
  let canonicalExecutionOrigin = null;
  if (fallback.executionUrl) {
    try {
      canonicalExecutionOrigin = httpOriginOfMaybeWs(fallback.executionUrl, `${id} execution`);
    } catch {
      canonicalExecutionOrigin = null;
    }
  }
  // Anneal DEFAULTS.endpoint is the 3000 execution port while the in-app UI is 5173.
  if (canonicalExecutionOrigin && overlay === canonicalExecutionOrigin && overlay !== canonical) {
    return canonical;
  }
  return overlay;
}

function serviceRecord(id, snapshotService = null) {
  const fallback = DEFAULT_IN_APP_LOOPBACKS[id];
  if (!fallback) throw new Error(`Unknown loopback mesh member: ${id}`);
  const url = overlayLoopbackUrl(id, fallback, snapshotService);
  const executionUrl = snapshotService?.executionEndpoint
    ? optionalLoopbackUrl(snapshotService.executionEndpoint, `${id} execution url`)
    : fallback.executionUrl;
  const openaiBaseUrl = fallback.openaiBaseUrl ? openaiBaseFrom(url) : null;
  const anthropicBaseUrl = fallback.anthropicBaseUrl ? openaiBaseFrom(url) : null;
  return Object.freeze({
    id,
    role: fallback.role,
    url,
    executionUrl,
    openaiBaseUrl,
    anthropicBaseUrl,
  });
}

function buildLoopbackMesh(services = []) {
  const byId = new Map((Array.isArray(services) ? services : []).map((service) => [service.id, service]));
  const records = Object.keys(DEFAULT_IN_APP_LOOPBACKS).map((id) => serviceRecord(id, byId.get(id) || null));
  return Object.freeze({
    schemaVersion: MESH_SCHEMA_VERSION,
    managedBy: "Coding Tools",
    loopbackOnly: true,
    services: Object.freeze(Object.fromEntries(records.map((record) => [record.id, record]))),
  });
}

function sanitizeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => (
      /^[A-Z][A-Z0-9_]*$/.test(key) && typeof entry === "string" && entry.length > 0
    )),
  );
}

function loopbackMeshEnvironment(mesh, {
  targetId = null,
  commandCodeApiKey = "",
  meshPath = "",
} = {}) {
  const services = mesh?.services || {};
  const commandcode = services["commandcode-proxy"];
  const router = services["codex-router"];
  const cpa = services.cpa;
  const paseo = services.paseo;
  const anneal = services.anneal;
  const env = {
    CODING_TOOLS_CODEX_ROUTER_URL: router?.url || "",
    CODING_TOOLS_COMMANDCODE_URL: commandcode?.url || "",
    CODING_TOOLS_COMMANDCODE_OPENAI_BASE_URL: commandcode?.openaiBaseUrl || "",
    CODING_TOOLS_COMMANDCODE_ANTHROPIC_BASE_URL: commandcode?.anthropicBaseUrl || "",
    CODING_TOOLS_CPA_URL: cpa?.url || "",
    CODING_TOOLS_PASEO_URL: paseo?.url || "",
    CODING_TOOLS_PASEO_EXECUTION_URL: paseo?.executionUrl || "",
    CODING_TOOLS_ANNEAL_URL: anneal?.url || "",
    CODING_TOOLS_ANNEAL_EXECUTION_URL: anneal?.executionUrl || "",
    ...(meshPath ? { CODING_TOOLS_LOOPBACK_MESH: meshPath } : {}),
  };
  if (targetId === "anneal" && commandcode?.openaiBaseUrl) {
    env.OPENAI_BASE_URL = commandcode.openaiBaseUrl;
    env.ANTHROPIC_BASE_URL = commandcode.anthropicBaseUrl || commandcode.openaiBaseUrl;
    if (typeof commandCodeApiKey === "string" && commandCodeApiKey) {
      env.OPENAI_API_KEY = commandCodeApiKey;
      env.ANTHROPIC_API_KEY = commandCodeApiKey;
      env.CODING_TOOLS_COMMANDCODE_API_KEY = commandCodeApiKey;
    }
  }
  return Object.freeze(sanitizeEnv(env));
}

function persistLoopbackMesh(filePath, mesh) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error("Loopback mesh path must be absolute");
  const serialized = `${JSON.stringify(mesh, null, 2)}\n`;
  if (/\buser_[A-Za-z0-9]/u.test(serialized) || serialized.includes("proxyApiKey")) {
    throw new Error("Loopback mesh must not contain secrets");
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(filePath, serialized);
  return filePath;
}

module.exports = {
  DEFAULT_IN_APP_LOOPBACKS,
  MESH_SCHEMA_VERSION,
  buildLoopbackMesh,
  loopbackMeshEnvironment,
  persistLoopbackMesh,
};
